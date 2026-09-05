import { randomUUID } from "node:crypto";

import { Prisma } from "../generated/prisma/client";

import { llmGatewayPrisma } from "./db";

export type LeaseKind =
  | "TOKEN_REFRESH"
  | "MODEL_DISCOVERY"
  | "QUOTA_REFRESH"
  | "ACCOUNT_CONCURRENCY"
  | "CLIENT_CONCURRENCY"
  | "HOUSEKEEPING";

export interface LeaseHandle {
  leaseKey: string;
  kind: LeaseKind;
  resourceId: string;
  slot: number;
  ownerId: string;
  expiresAt: Date;
}

export class GatewayLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super("Gateway distributed lease was lost", { cause });
    this.name = "GatewayLeaseLostError";
  }
}

const keyFor = (kind: LeaseKind, resourceId: string, slot: number): string =>
  `${kind}:${resourceId}:${slot}`;

export const isLeaseContentionError = (error: unknown): boolean => {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  ) {
    return true;
  }
  let current = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;

    if (
      record.kind === "TransactionWriteConflict" ||
      record.originalCode === "40001" ||
      record.originalCode === "23505"
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
};

/**
 * Atomically insert or reclaim one expired lease. The unique key arbitrates
 * contenders for the same slot without serializable predicate conflicts
 * rejecting independent requests on unrelated slots.
 */
export const tryAcquireLease = async (input: {
  kind: LeaseKind;
  resourceId: string;
  slot?: number;
  ttlMs: number;
  ownerId?: string;
  now?: Date;
}): Promise<LeaseHandle | null> => {
  const slot = input.slot ?? 0;
  const ownerId = input.ownerId ?? randomUUID();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const leaseKey = keyFor(input.kind, input.resourceId, slot);

  const rows = await llmGatewayPrisma.$queryRaw<LeaseHandle[]>`
    WITH inserted AS (
      INSERT INTO "GatewayLease"
        ("leaseKey", "kind", "resourceId", "slot", "ownerId",
         "acquiredAt", "heartbeatAt", "expiresAt")
      VALUES
        (${leaseKey}, ${input.kind}::"GatewayLeaseKind", ${input.resourceId},
         ${slot}, ${ownerId}, ${now}, ${now}, ${expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING "leaseKey", "kind", "resourceId", "slot", "ownerId", "expiresAt"
    ), reclaimed AS (
      UPDATE "GatewayLease" SET
        "ownerId" = ${ownerId},
        "acquiredAt" = ${now},
        "heartbeatAt" = ${now},
        "expiresAt" = ${expiresAt}
      WHERE "leaseKey" = ${leaseKey} AND "expiresAt" <= ${now}
      RETURNING "leaseKey", "kind", "resourceId", "slot", "ownerId", "expiresAt"
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT * FROM reclaimed
  `;

  return rows[0] ?? null;
};

/** Claim the first available slot under a distributed concurrency limit. */
export const tryAcquireConcurrencyLease = async (input: {
  kind: "ACCOUNT_CONCURRENCY" | "CLIENT_CONCURRENCY";
  resourceId: string;
  maxConcurrency: number | null;
  ttlMs: number;
  ownerId?: string;
}): Promise<LeaseHandle | null> => {
  if (input.maxConcurrency === null) {
    // Unlimited resources still get a unique request lease so cleanup and
    // diagnostics can identify active work without imposing a slot ceiling.
    return tryAcquireLease({
      ...input,
      resourceId: `${input.resourceId}:${randomUUID()}`,
      slot: 0,
    });
  }

  for (let slot = 0; slot < input.maxConcurrency; slot += 1) {
    const lease = await tryAcquireLease({ ...input, slot });

    if (lease) return lease;
  }

  return null;
};

export const heartbeatLease = async (
  handle: LeaseHandle,
  ttlMs: number,
): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const result = await llmGatewayPrisma.gatewayLease.updateMany({
    where: {
      leaseKey: handle.leaseKey,
      ownerId: handle.ownerId,
      expiresAt: { gt: now },
    },
    data: { heartbeatAt: now, expiresAt },
  });

  if (result.count === 1) handle.expiresAt = expiresAt;

  return result.count === 1;
};

export const releaseLease = async (handle: LeaseHandle): Promise<void> => {
  await llmGatewayPrisma.gatewayLease.deleteMany({
    where: { leaseKey: handle.leaseKey, ownerId: handle.ownerId },
  });
};

export const releaseLeases = async (
  handles: Array<LeaseHandle | null | undefined>,
): Promise<void> => {
  await Promise.all(
    handles
      .filter((handle): handle is LeaseHandle => Boolean(handle))
      .map((handle) => releaseLease(handle)),
  );
};

export interface LeaseGuardDependencies {
  heartbeat: typeof heartbeatLease;
  release: typeof releaseLeases;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

export interface LeaseGuardOptions {
  leases?: LeaseHandle[];
  ttlMs: number;
  heartbeatIntervalMs: number;
  /** Caller cancellation is combined with lease loss and the hard deadline. */
  signal?: AbortSignal;
  timeoutMs?: number;
  dependencies?: Partial<LeaseGuardDependencies>;
}

const leaseIdentity = (handle: LeaseHandle): string =>
  `${handle.leaseKey}:${handle.ownerId}`;

/**
 * Owns the complete lifecycle of one or more distributed leases.
 *
 * The guard is deliberately dynamic: a request can start with its client
 * lease, add an account lease after routing, release that account on retry,
 * and hand the same guard to the streamed-response lifecycle. A lost or
 * failed heartbeat aborts `signal`, allowing in-flight provider requests to
 * be cancelled instead of continuing after their concurrency slot expired.
 */
export class LeaseGuard {
  readonly signal: AbortSignal;

  private readonly leases = new Map<string, LeaseHandle>();
  private readonly controller = new AbortController();
  private readonly dependencies: LeaseGuardDependencies;
  private readonly ttlMs: number;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null;
  private heartbeatInFlight = false;
  private stopped = false;

  constructor(options: LeaseGuardOptions) {
    this.ttlMs = options.ttlMs;
    this.dependencies = {
      heartbeat: heartbeatLease,
      release: releaseLeases,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      ...options.dependencies,
    };
    for (const lease of options.leases ?? []) this.addLease(lease);

    const signals = [this.controller.signal];

    if (options.signal) signals.push(options.signal);
    if (options.timeoutMs !== undefined) {
      signals.push(AbortSignal.timeout(options.timeoutMs));
    }
    this.signal = AbortSignal.any(signals);
    this.heartbeatTimer = this.dependencies.setInterval(
      () => void this.heartbeat(),
      options.heartbeatIntervalMs,
    );
    const stopHeartbeat = () => {
      if (this.heartbeatTimer) {
        this.dependencies.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    };

    if (this.signal.aborted) stopHeartbeat();
    else this.signal.addEventListener("abort", stopHeartbeat, { once: true });
  }

  addLease(handle: LeaseHandle): void {
    if (this.stopped) {
      throw new Error("Cannot add a lease to a stopped guard");
    }
    this.leases.set(leaseIdentity(handle), handle);
  }

  removeLease(handle: LeaseHandle): void {
    this.leases.delete(leaseIdentity(handle));
  }

  throwIfFailed(): void {
    this.signal.throwIfAborted();
  }

  private fail(cause?: unknown): void {
    if (this.stopped || this.controller.signal.aborted) return;
    this.controller.abort(new GatewayLeaseLostError(cause));
  }

  private async heartbeat(): Promise<void> {
    if (
      this.stopped ||
      this.signal.aborted ||
      this.heartbeatInFlight ||
      this.leases.size === 0
    ) {
      return;
    }
    this.heartbeatInFlight = true;
    const targets = [...this.leases.entries()];

    try {
      const results = await Promise.allSettled(
        targets.map(([, lease]) =>
          this.dependencies.heartbeat(lease, this.ttlMs),
        ),
      );

      for (let index = 0; index < results.length; index += 1) {
        const [identity, target] = targets[index]!;

        // A retry can intentionally remove/release a lease while its previous
        // heartbeat is in flight. That stale result must not abort the request.
        if (this.leases.get(identity) !== target) continue;
        const result = results[index]!;

        if (result.status === "rejected") {
          this.fail(result.reason);

          return;
        }
        if (!result.value) {
          this.fail();

          return;
        }
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /** Remove and best-effort release one lease without stopping the guard. */
  async releaseLease(handle: LeaseHandle): Promise<void> {
    this.removeLease(handle);
    await Promise.allSettled([this.dependencies.release([handle])]);
  }

  /** Stop heartbeats and best-effort release every lease still owned. */
  async finish(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      this.dependencies.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const handles = [...this.leases.values()];

    this.leases.clear();
    await Promise.allSettled([this.dependencies.release(handles)]);
  }
}

export const createLeaseGuard = (options: LeaseGuardOptions): LeaseGuard =>
  new LeaseGuard(options);

export const countActiveLeases = async (
  kind: "ACCOUNT_CONCURRENCY" | "CLIENT_CONCURRENCY",
  resourceId: string,
  now = new Date(),
): Promise<number> =>
  llmGatewayPrisma.gatewayLease.count({
    where: {
      kind,
      expiresAt: { gt: now },
      OR: [
        { resourceId },
        // Unlimited leases suffix the request UUID onto the resource ID.
        { resourceId: { startsWith: `${resourceId}:` } },
      ],
    },
  });

export const deleteExpiredLeases = async (
  now = new Date(),
): Promise<number> => {
  const result = await llmGatewayPrisma.gatewayLease.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  return result.count;
};

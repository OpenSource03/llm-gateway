import type { LeaseHandle } from "./leases";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createLeaseGuard,
  GatewayLeaseLostError,
  isLeaseContentionError,
} from "./leases";

const lease = (suffix: string): LeaseHandle => ({
  leaseKey: `CLIENT_CONCURRENCY:${suffix}:0`,
  kind: "CLIENT_CONCURRENCY",
  resourceId: suffix,
  slot: 0,
  ownerId: `owner-${suffix}`,
  expiresAt: new Date(Date.now() + 120_000),
});

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out while waiting for the expected condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

test("adapter-wrapped PostgreSQL serialization conflicts are normal contention", () => {
  assert.equal(
    isLeaseContentionError({
      name: "DriverAdapterError",
      cause: {
        kind: "TransactionWriteConflict",
        originalCode: "40001",
      },
    }),
    true,
  );
  assert.equal(
    isLeaseContentionError({
      name: "DriverAdapterError",
      cause: { originalCode: "08006" },
    }),
    false,
  );
});

test("a false heartbeat aborts the guarded operation and releases its lease", async () => {
  const released: LeaseHandle[][] = [];
  const guard = createLeaseGuard({
    leases: [lease("false")],
    ttlMs: 100,
    heartbeatIntervalMs: 1,
    dependencies: {
      heartbeat: async () => false,
      release: async (handles) => {
        released.push(
          handles.filter((handle): handle is LeaseHandle => !!handle),
        );
      },
    },
  });

  await waitForAbort(guard.signal);
  assert.ok(guard.signal.reason instanceof GatewayLeaseLostError);
  await guard.finish();
  assert.equal(released.flat().length, 1);
});

test("a heartbeat database error aborts the guarded operation with its cause", async () => {
  const databaseError = new Error("database unavailable");
  const guard = createLeaseGuard({
    leases: [lease("error")],
    ttlMs: 100,
    heartbeatIntervalMs: 1,
    dependencies: {
      heartbeat: async () => {
        throw databaseError;
      },
      release: async () => undefined,
    },
  });

  await waitForAbort(guard.signal);
  assert.ok(guard.signal.reason instanceof GatewayLeaseLostError);
  assert.equal(guard.signal.reason.cause, databaseError);
  await guard.finish();
});

test("heartbeats continue for a slow operation without overlapping", async () => {
  let heartbeatCalls = 0;
  let concurrentHeartbeats = 0;
  let maximumConcurrentHeartbeats = 0;
  const guard = createLeaseGuard({
    leases: [lease("slow")],
    ttlMs: 100,
    heartbeatIntervalMs: 1,
    dependencies: {
      heartbeat: async () => {
        heartbeatCalls += 1;
        concurrentHeartbeats += 1;
        maximumConcurrentHeartbeats = Math.max(
          maximumConcurrentHeartbeats,
          concurrentHeartbeats,
        );
        await new Promise((resolve) => setTimeout(resolve, 4));
        concurrentHeartbeats -= 1;

        return true;
      },
      release: async () => undefined,
    },
  });

  await waitUntil(() => heartbeatCalls >= 3);
  assert.equal(guard.signal.aborted, false);
  assert.ok(heartbeatCalls >= 3);
  assert.equal(maximumConcurrentHeartbeats, 1);
  await guard.finish();
});

test("a stale heartbeat result cannot abort after a retry releases that lease", async () => {
  let resolveHeartbeat: ((renewed: boolean) => void) | undefined;
  const handle = lease("removed");
  const guard = createLeaseGuard({
    leases: [handle],
    ttlMs: 100,
    heartbeatIntervalMs: 1,
    dependencies: {
      heartbeat: () =>
        new Promise<boolean>((resolve) => {
          resolveHeartbeat = resolve;
        }),
      release: async () => undefined,
    },
  });

  while (!resolveHeartbeat) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await guard.releaseLease(handle);
  resolveHeartbeat(false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(guard.signal.aborted, false);
  await guard.finish();
});

test("an already-aborted caller signal never starts lease heartbeats", async () => {
  let intervals = 0;
  let clears = 0;
  const controller = new AbortController();

  controller.abort(new Error("already cancelled"));
  const guard = createLeaseGuard({
    leases: [lease("pre-aborted")],
    ttlMs: 100,
    heartbeatIntervalMs: 1,
    signal: controller.signal,
    dependencies: {
      heartbeat: async () => true,
      release: async () => undefined,
      setInterval: ((callback: () => void, delay?: number) => {
        intervals += 1;

        return globalThis.setInterval(callback, delay);
      }) as typeof globalThis.setInterval,
      clearInterval: ((timer) => {
        clears += 1;
        globalThis.clearInterval(timer);
      }) as typeof globalThis.clearInterval,
    },
  });

  assert.equal(guard.signal.aborted, true);
  assert.equal(intervals, 1);
  assert.equal(clears, 1);
  await guard.finish();
});

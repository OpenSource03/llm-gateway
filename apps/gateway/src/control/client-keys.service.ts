import type { ActorReference } from "../middleware/control-principal";

import { randomUUID } from "node:crypto";

import { llmGatewayPrisma } from "../core/db";
import { GatewayError } from "../core/errors";
import {
  constantTimeHexEqual,
  createGatewayClientSecret,
  isGatewayClientSecret,
  sha256Hex,
} from "../core/security/secrets";
import Logger from "../config/logger";
import { reconciledBillableInputTokens } from "../core/usage-accounting";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_USED_THROTTLE_MS = 60_000;
const RECONCILED_RESERVATION_CACHE_SIZE = 10_000;

const usageWindowStart = (now: Date): Date => {
  const start = new Date(now.getTime() - DAY_MS);

  // Buckets are hourly. Include the partial boundary bucket so rolling limits
  // fail conservatively instead of omitting up to 59 minutes of usage.
  start.setUTCMinutes(0, 0, 0);

  return start;
};

const usageBucketStart = (now: Date): Date => {
  const start = new Date(now);

  start.setUTCMinutes(0, 0, 0);

  return start;
};

export interface GatewayClientKeyRow {
  id: string;
  name: string;
  ownerLabel: string;
  ownerEmail: string | null;
  keyPrefix: string;
  status: "active" | "disabled" | "expired" | "revoked";
  allowAllModels: boolean;
  allowedModelIds: string[];
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

type KeyWithModels = {
  id: string;
  name: string;
  ownerLabel: string;
  ownerEmail: string | null;
  keyPrefix: string;
  enabled: boolean;
  allowAllModels: boolean;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: bigint | null;
  dailyOutputTokenCap: bigint | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  allowedModels: Array<{ model: { publicModelId: string } }>;
};

const toRow = (key: KeyWithModels): GatewayClientKeyRow => ({
  id: key.id,
  name: key.name,
  ownerLabel: key.ownerLabel,
  ownerEmail: key.ownerEmail,
  keyPrefix: key.keyPrefix,
  status: key.revokedAt
    ? "revoked"
    : key.expiresAt && key.expiresAt <= new Date()
      ? "expired"
      : key.enabled
        ? "active"
        : "disabled",
  allowAllModels: key.allowAllModels,
  allowedModelIds: key.allowedModels.map(({ model }) => model.publicModelId),
  maxConcurrency: key.maxConcurrency,
  dailyRequestCap: key.dailyRequestCap,
  dailyInputTokenCap: key.dailyInputTokenCap?.toString() ?? null,
  dailyOutputTokenCap: key.dailyOutputTokenCap?.toString() ?? null,
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  expiresAt: key.expiresAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
});

const includeModels = {
  allowedModels: { include: { model: { select: { publicModelId: true } } } },
} as const;

export const listGatewayClientKeys = async (): Promise<
  GatewayClientKeyRow[]
> => {
  const keys = await llmGatewayPrisma.gatewayClientKey.findMany({
    include: includeModels,
    orderBy: { createdAt: "desc" },
  });

  return keys.map(toRow);
};

export interface CreateGatewayClientKeyInput {
  name: string;
  ownerLabel: string;
  ownerEmail?: string | null;
  allowAllModels: boolean;
  allowedModelIds: string[];
  expiresInDays?: number | null;
  maxConcurrency?: number | null;
  dailyRequestCap?: number | null;
  dailyInputTokenCap?: bigint | null;
  dailyOutputTokenCap?: bigint | null;
}

export const createGatewayClientKey = async (
  actor: ActorReference,
  input: CreateGatewayClientKeyInput,
): Promise<GatewayClientKeyRow & { key: string }> => {
  const requested = [...new Set(input.allowedModelIds)];
  const models = requested.length
    ? await llmGatewayPrisma.gatewayModel.findMany({
        where: { publicModelId: { in: requested }, enabled: true },
        select: { id: true, publicModelId: true },
      })
    : [];

  if (!input.allowAllModels && requested.length === 0) {
    throw new GatewayError(
      "Select at least one model or allow all enabled models",
      400,
      "NO_MODELS",
    );
  }
  if (models.length !== requested.length) {
    throw new GatewayError(
      "One or more selected models are unavailable",
      400,
      "UNKNOWN_MODEL",
    );
  }

  const generated = createGatewayClientSecret();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * DAY_MS)
    : null;
  const created = await llmGatewayPrisma.gatewayClientKey.create({
    data: {
      name: input.name,
      ownerLabel: input.ownerLabel,
      ownerEmail: input.ownerEmail || null,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      allowAllModels: input.allowAllModels,
      maxConcurrency: input.maxConcurrency ?? null,
      dailyRequestCap: input.dailyRequestCap ?? null,
      dailyInputTokenCap: input.dailyInputTokenCap ?? null,
      dailyOutputTokenCap: input.dailyOutputTokenCap ?? null,
      createdByActorId: actor.id,
      expiresAt,
      allowedModels: {
        create: models.map((model) => ({ modelId: model.id })),
      },
    },
    include: includeModels,
  });

  return { ...toRow(created), key: generated.secret };
};

export const revokeGatewayClientKey = async (
  keyId: string,
): Promise<GatewayClientKeyRow> => {
  const existing = await llmGatewayPrisma.gatewayClientKey.findUnique({
    where: { id: keyId },
    include: includeModels,
  });

  if (!existing)
    throw new GatewayError("Client key not found", 404, "NOT_FOUND");
  if (existing.revokedAt) return toRow(existing);

  const revoked = await llmGatewayPrisma.gatewayClientKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date(), enabled: false },
    include: includeModels,
  });

  return toRow(revoked);
};

export interface GatewayClientPrincipal {
  id: string;
  name: string;
  allowAllModels: boolean;
  allowedModelIds: Set<string>;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: bigint | null;
  dailyOutputTokenCap: bigint | null;
}

export interface GatewayClientUsageReservation {
  clientKeyId: string;
  modelId: string;
  bucketStart: Date;
  inputTokens: bigint;
  outputTokens: bigint;
  reservationId: string;
}

export const authenticateGatewayClientKey = async (
  presented: string,
): Promise<GatewayClientPrincipal> => {
  if (!isGatewayClientSecret(presented)) {
    throw new GatewayError("Invalid gateway key", 401, "INVALID_GATEWAY_KEY");
  }
  const hash = sha256Hex(presented);
  const key = await llmGatewayPrisma.gatewayClientKey.findUnique({
    where: { keyHash: hash },
    include: includeModels,
  });

  if (!key || !constantTimeHexEqual(key.keyHash, hash)) {
    throw new GatewayError("Invalid gateway key", 401, "INVALID_GATEWAY_KEY");
  }
  if (key.revokedAt || !key.enabled) {
    throw new GatewayError("Gateway key revoked", 401, "GATEWAY_KEY_REVOKED");
  }
  if (key.expiresAt && key.expiresAt <= new Date()) {
    throw new GatewayError("Gateway key expired", 401, "GATEWAY_KEY_EXPIRED");
  }

  if (
    !key.lastUsedAt ||
    Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS
  ) {
    void llmGatewayPrisma.gatewayClientKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() =>
        Logger.warn("Gateway key usage timestamp update failed", {
          clientKeyId: key.id,
        }),
      );
  }

  return {
    id: key.id,
    name: key.name,
    allowAllModels: key.allowAllModels,
    allowedModelIds: new Set(
      key.allowedModels.map(({ model }) => model.publicModelId),
    ),
    maxConcurrency: key.maxConcurrency,
    dailyRequestCap: key.dailyRequestCap,
    dailyInputTokenCap: key.dailyInputTokenCap,
    dailyOutputTokenCap: key.dailyOutputTokenCap,
  };
};

const assertCapacity = (
  principal: GatewayClientPrincipal,
  usage: { requests: number; inputTokens: bigint; outputTokens: bigint },
  estimatedInputTokens: bigint,
  requestedOutputTokens: bigint,
  requestIncrement: 0 | 1,
): void => {
  if (
    principal.dailyRequestCap !== null &&
    usage.requests + requestIncrement > principal.dailyRequestCap
  ) {
    throw new GatewayError(
      "Client daily request cap reached",
      429,
      "CLIENT_DAILY_CAP",
    );
  }
  if (
    principal.dailyInputTokenCap !== null &&
    usage.inputTokens + estimatedInputTokens > principal.dailyInputTokenCap
  ) {
    throw new GatewayError(
      "Client daily input cap reached",
      429,
      "CLIENT_DAILY_CAP",
    );
  }
  if (
    principal.dailyOutputTokenCap !== null &&
    usage.outputTokens + requestedOutputTokens > principal.dailyOutputTokenCap
  ) {
    throw new GatewayError(
      "Client daily output cap reached",
      429,
      "CLIENT_DAILY_CAP",
    );
  }
};

export const assertClientDailyCapacity = async (
  principal: GatewayClientPrincipal,
  estimatedInputTokens: number,
  requestedOutputTokens = 0,
): Promise<void> => {
  const now = new Date();
  const aggregate = await llmGatewayPrisma.gatewayUsageBucket.aggregate({
    where: {
      scopeType: "CLIENT_KEY",
      scopeId: principal.id,
      bucketStart: { gte: usageWindowStart(now) },
    },
    _sum: { requestCount: true, inputTokens: true, outputTokens: true },
  });

  assertCapacity(
    principal,
    {
      requests: aggregate._sum.requestCount ?? 0,
      inputTokens: aggregate._sum.inputTokens ?? 0n,
      outputTokens: aggregate._sum.outputTokens ?? 0n,
    },
    BigInt(estimatedInputTokens),
    BigInt(requestedOutputTokens),
    1,
  );
};

interface ClientCapacityReservationInput {
  modelId: string;
  estimatedInputTokens: number;
  requestedOutputTokens?: number;
}

const reserveClientCapacity = async (
  principal: GatewayClientPrincipal,
  input: ClientCapacityReservationInput,
  counters: { requestIncrement: 0 | 1; retryIncrement: 0 | 1 },
): Promise<GatewayClientUsageReservation> => {
  const now = new Date();
  const bucket = usageBucketStart(now);
  const reservedInput = BigInt(input.estimatedInputTokens);
  const reservedOutput = BigInt(input.requestedOutputTokens ?? 0);
  const reservationId = randomUUID();

  await llmGatewayPrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT 1::int AS locked FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-client:${principal.id}`}, 0)
        )
      `;
      const aggregate = await tx.gatewayUsageBucket.aggregate({
        where: {
          scopeType: "CLIENT_KEY",
          scopeId: principal.id,
          bucketStart: { gte: usageWindowStart(now) },
        },
        _sum: { requestCount: true, inputTokens: true, outputTokens: true },
      });

      assertCapacity(
        principal,
        {
          requests: aggregate._sum.requestCount ?? 0,
          inputTokens: aggregate._sum.inputTokens ?? 0n,
          outputTokens: aggregate._sum.outputTokens ?? 0n,
        },
        reservedInput,
        reservedOutput,
        counters.requestIncrement,
      );
      await tx.gatewayUsageBucket.upsert({
        where: {
          bucketStart_scopeType_scopeId_modelId: {
            bucketStart: bucket,
            scopeType: "CLIENT_KEY",
            scopeId: principal.id,
            modelId: input.modelId,
          },
        },
        create: {
          bucketStart: bucket,
          scopeType: "CLIENT_KEY",
          scopeId: principal.id,
          modelId: input.modelId,
          requestCount: counters.requestIncrement,
          retryCount: counters.retryIncrement,
          inputTokens: reservedInput,
          outputTokens: reservedOutput,
        },
        update: {
          requestCount: { increment: counters.requestIncrement },
          retryCount: { increment: counters.retryIncrement },
          inputTokens: { increment: reservedInput },
          outputTokens: { increment: reservedOutput },
        },
      });
    },
    // The per-client advisory lock provides serialization. Read committed
    // ensures a waiter observes the prior holder's committed reservation
    // rather than taking a stale serializable snapshot and failing spuriously.
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return {
    clientKeyId: principal.id,
    modelId: input.modelId,
    bucketStart: bucket,
    inputTokens: reservedInput,
    outputTokens: reservedOutput,
    reservationId,
  };
};

/**
 * Atomically check and reserve one caller-visible request against a client
 * key's rolling limits. PostgreSQL's transaction-scoped advisory lock closes
 * the write-skew gap across models and App Service replicas; the projected
 * output is later reconciled to provider-reported usage.
 */
export const reserveClientDailyCapacity = async (
  principal: GatewayClientPrincipal,
  input: ClientCapacityReservationInput,
): Promise<GatewayClientUsageReservation> =>
  reserveClientCapacity(principal, input, {
    requestIncrement: 1,
    retryIncrement: 0,
  });

/**
 * Reserve another upstream attempt for an already-counted client request.
 * Retries consume their own projected token capacity and telemetry counter,
 * but deliberately do not consume a second daily request slot.
 */
export const reserveClientRetryCapacity = async (
  principal: GatewayClientPrincipal,
  input: ClientCapacityReservationInput,
): Promise<GatewayClientUsageReservation> =>
  reserveClientCapacity(principal, input, {
    requestIncrement: 0,
    retryIncrement: 1,
  });

const reconciledClientReservations = new Set<string>();
const inFlightClientReconciliations = new Map<string, Promise<void>>();

const rememberReconciledClientReservation = (reservationId: string): void => {
  reconciledClientReservations.add(reservationId);
  if (reconciledClientReservations.size > RECONCILED_RESERVATION_CACHE_SIZE) {
    const oldest = reconciledClientReservations.values().next().value as
      string | undefined;

    if (oldest) reconciledClientReservations.delete(oldest);
  }
};

/**
 * Reconcile one in-process reservation idempotently. A persistent reservation
 * ledger would be warranted for exact billing or replay after an ambiguous
 * database commit. It is intentionally unnecessary for cap enforcement here:
 * the projection is committed first, and a worker crash before reconciliation
 * leaves that conservative reservation counted until its rolling window ages
 * out instead of reopening capacity.
 */
export const reconcileClientUsageReservation = async (
  reservation: GatewayClientUsageReservation,
  actual: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    error?: boolean;
  },
): Promise<void> => {
  if (reconciledClientReservations.has(reservation.reservationId)) return;
  const inFlight = inFlightClientReconciliations.get(reservation.reservationId);

  if (inFlight) return inFlight;
  const actualInput = reconciledBillableInputTokens({
    reservedInputTokens: reservation.inputTokens,
    inputTokens: actual.inputTokens,
    cachedInputTokens: actual.cachedInputTokens,
  });
  const actualOutput =
    actual.outputTokens === undefined
      ? actual.error
        ? 0n
        : reservation.outputTokens
      : BigInt(actual.outputTokens);
  const reconcile = (async () => {
    await llmGatewayPrisma.gatewayUsageBucket.update({
      where: {
        bucketStart_scopeType_scopeId_modelId: {
          bucketStart: reservation.bucketStart,
          scopeType: "CLIENT_KEY",
          scopeId: reservation.clientKeyId,
          modelId: reservation.modelId,
        },
      },
      data: {
        inputTokens: { increment: actualInput - reservation.inputTokens },
        outputTokens: { increment: actualOutput - reservation.outputTokens },
        cachedInputTokens: {
          increment: BigInt(actual.cachedInputTokens ?? 0),
        },
        errorCount: { increment: actual.error ? 1 : 0 },
      },
    });
    // Mark only after PostgreSQL acknowledges the update. Concurrent duplicate
    // callbacks share this promise; failures clear the in-flight entry so the
    // original reservation can be retried without silently losing telemetry.
    rememberReconciledClientReservation(reservation.reservationId);
  })();

  inFlightClientReconciliations.set(reservation.reservationId, reconcile);
  try {
    await reconcile;
  } finally {
    if (
      inFlightClientReconciliations.get(reservation.reservationId) === reconcile
    ) {
      inFlightClientReconciliations.delete(reservation.reservationId);
    }
  }
};

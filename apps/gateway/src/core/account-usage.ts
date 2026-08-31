import { llmGatewayPrisma } from "./db";
import { GatewayError } from "./errors";
import { reconciledBillableInputTokens } from "./usage-accounting";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ROUTING_POOL counters are intentionally scoped to a member, not merely the
 * pool. Length-prefixing both IDs keeps the encoding injective even if a future
 * identifier format contains the separator.
 */
export const routingPoolUsageScopePrefix = (routingPoolId: string): string =>
  `pool-account:v1:${routingPoolId.length}:${routingPoolId}:`;

export const routingPoolAccountUsageScopeId = (
  routingPoolId: string,
  accountId: string,
): string =>
  `${routingPoolUsageScopePrefix(routingPoolId)}${accountId.length}:${accountId}`;

export interface GatewayAccountDailyCaps {
  requests: number | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
}

export interface GatewayAccountUsageReservation {
  accountId: string;
  routingPoolId: string;
  modelId: string;
  bucketStart: Date;
  inputTokens: bigint;
  outputTokens: bigint;
  reservationId: string;
}

export const strictestAccountCap = (
  memberCap: bigint | null,
  accountCap: bigint | null,
): bigint | null => {
  if (memberCap === null) return accountCap;
  if (accountCap === null) return memberCap;

  return memberCap < accountCap ? memberCap : accountCap;
};

/**
 * Usage is stored in hourly buckets. Including the complete boundary hour is
 * intentionally conservative: a rolling cap can count up to 59 extra minutes,
 * but it can never omit the partial boundary bucket and admit excess traffic.
 */
export const accountUsageWindowStart = (now: Date): Date => {
  const start = new Date(now.getTime() - DAY_MS);

  start.setUTCMinutes(0, 0, 0);

  return start;
};

const usageBucketStart = (now: Date): Date => {
  const start = new Date(now);

  start.setUTCMinutes(0, 0, 0);

  return start;
};

const toTokenCount = (value: number): bigint =>
  BigInt(Math.max(0, Math.trunc(value)));

const assertAccountCapacity = (
  caps: GatewayAccountDailyCaps,
  usage: { requests: number; inputTokens: bigint; outputTokens: bigint },
  projectedInput: bigint,
  projectedOutput: bigint,
  scope: "account" | "routing member",
  code: "ACCOUNT_DAILY_CAP" | "ROUTING_MEMBER_DAILY_CAP",
): void => {
  if (caps.requests !== null && usage.requests + 1 > caps.requests) {
    throw new GatewayError(
      `Subscription ${scope} daily request cap reached`,
      429,
      code,
    );
  }
  if (
    caps.inputTokens !== null &&
    usage.inputTokens + projectedInput > caps.inputTokens
  ) {
    throw new GatewayError(
      `Subscription ${scope} daily input cap reached`,
      429,
      code,
    );
  }
  if (
    caps.outputTokens !== null &&
    usage.outputTokens + projectedOutput > caps.outputTokens
  ) {
    throw new GatewayError(
      `Subscription ${scope} daily output cap reached`,
      429,
      code,
    );
  }
};

/**
 * Atomically reserve a routed upstream attempt against the account/member
 * limits. The transaction-scoped advisory lock serializes the aggregate check
 * across every model, pool, process, and App Service replica for this account.
 * Read committed is deliberate: a waiter must observe the preceding lock
 * holder's committed reservation rather than retain an older transaction
 * snapshot.
 */
export const reserveAccountDailyCapacity = async (input: {
  accountId: string;
  routingPoolId: string;
  modelId: string;
  accountCaps: GatewayAccountDailyCaps;
  memberCaps: GatewayAccountDailyCaps;
  maxTrafficShareBps: number | null;
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  retry: boolean;
  now?: Date;
}): Promise<GatewayAccountUsageReservation> => {
  const now = input.now ?? new Date();
  const bucketStart = usageBucketStart(now);
  const projectedInput = toTokenCount(input.estimatedInputTokens);
  const projectedOutput = toTokenCount(input.requestedOutputTokens);
  const reservationId = crypto.randomUUID();
  const memberScopeId = routingPoolAccountUsageScopeId(
    input.routingPoolId,
    input.accountId,
  );
  const scopes = [
    ["ACCOUNT", input.accountId],
    ["ROUTING_POOL", memberScopeId],
  ] as const;

  await llmGatewayPrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-routing-pool:${input.routingPoolId}`}, 0)
        )
      `;
      await tx.$queryRaw`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-account:${input.accountId}`}, 0)
        )
      `;
      const [accountAggregate, memberAggregate] = await Promise.all([
        tx.gatewayUsageBucket.aggregate({
          where: {
            scopeType: "ACCOUNT",
            scopeId: input.accountId,
            bucketStart: { gte: accountUsageWindowStart(now) },
          },
          _sum: { requestCount: true, inputTokens: true, outputTokens: true },
        }),
        tx.gatewayUsageBucket.aggregate({
          where: {
            scopeType: "ROUTING_POOL",
            scopeId: memberScopeId,
            bucketStart: { gte: accountUsageWindowStart(now) },
          },
          _sum: { requestCount: true, inputTokens: true, outputTokens: true },
        }),
      ]);

      if (input.maxTrafficShareBps !== null) {
        const poolAggregate = await tx.gatewayUsageBucket.aggregate({
          where: {
            scopeType: "ROUTING_POOL",
            scopeId: {
              startsWith: routingPoolUsageScopePrefix(input.routingPoolId),
            },
            bucketStart: { gte: accountUsageWindowStart(now) },
          },
          _sum: { requestCount: true },
        });
        const poolRequests = poolAggregate._sum.requestCount ?? 0;
        const memberRequests = memberAggregate._sum.requestCount ?? 0;
        const shareBps =
          poolRequests > 0
            ? Math.round((memberRequests / poolRequests) * 10_000)
            : 0;

        if (shareBps > input.maxTrafficShareBps) {
          throw new GatewayError(
            "Routing member traffic-share ceiling reached",
            429,
            "TRAFFIC_SHARE_CAP",
          );
        }
      }

      assertAccountCapacity(
        input.accountCaps,
        {
          requests: accountAggregate._sum.requestCount ?? 0,
          inputTokens: accountAggregate._sum.inputTokens ?? 0n,
          outputTokens: accountAggregate._sum.outputTokens ?? 0n,
        },
        projectedInput,
        projectedOutput,
        "account",
        "ACCOUNT_DAILY_CAP",
      );
      assertAccountCapacity(
        input.memberCaps,
        {
          requests: memberAggregate._sum.requestCount ?? 0,
          inputTokens: memberAggregate._sum.inputTokens ?? 0n,
          outputTokens: memberAggregate._sum.outputTokens ?? 0n,
        },
        projectedInput,
        projectedOutput,
        "routing member",
        "ROUTING_MEMBER_DAILY_CAP",
      );
      for (const [scopeType, scopeId] of scopes) {
        await tx.gatewayUsageBucket.upsert({
          where: {
            bucketStart_scopeType_scopeId_modelId: {
              bucketStart,
              scopeType,
              scopeId,
              modelId: input.modelId,
            },
          },
          create: {
            bucketStart,
            scopeType,
            scopeId,
            modelId: input.modelId,
            requestCount: 1,
            retryCount: input.retry ? 1 : 0,
            inputTokens: projectedInput,
            outputTokens: projectedOutput,
          },
          update: {
            requestCount: { increment: 1 },
            retryCount: { increment: input.retry ? 1 : 0 },
            inputTokens: { increment: projectedInput },
            outputTokens: { increment: projectedOutput },
          },
        });
      }
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return {
    accountId: input.accountId,
    routingPoolId: input.routingPoolId,
    modelId: input.modelId,
    bucketStart,
    inputTokens: projectedInput,
    outputTokens: projectedOutput,
    reservationId,
  };
};

const reconciledReservations = new Set<string>();

const usageDelta = (
  reservation: GatewayAccountUsageReservation,
  actual: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    error?: boolean;
  },
) => {
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
      : toTokenCount(actual.outputTokens);
  const cachedInput = toTokenCount(actual.cachedInputTokens ?? 0);

  return {
    inputTokens: actualInput - reservation.inputTokens,
    outputTokens: actualOutput - reservation.outputTokens,
    cachedInputTokens: cachedInput,
    errorCount: actual.error ? 1 : 0,
  };
};

/**
 * Reconcile a projection once for this process. Callers retain the reservation
 * until this transaction succeeds, so transient DB failures can be retried.
 */
export const reconcileAccountUsageReservation = async (
  reservation: GatewayAccountUsageReservation,
  actual: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    error?: boolean;
  },
): Promise<void> => {
  if (reconciledReservations.has(reservation.reservationId)) return;
  const delta = usageDelta(reservation, actual);
  const scopes = [
    ["ACCOUNT", reservation.accountId],
    [
      "ROUTING_POOL",
      routingPoolAccountUsageScopeId(
        reservation.routingPoolId,
        reservation.accountId,
      ),
    ],
  ] as const;

  await llmGatewayPrisma.$transaction(
    scopes.map(([scopeType, scopeId]) =>
      llmGatewayPrisma.gatewayUsageBucket.update({
        where: {
          bucketStart_scopeType_scopeId_modelId: {
            bucketStart: reservation.bucketStart,
            scopeType,
            scopeId,
            modelId: reservation.modelId,
          },
        },
        data: {
          inputTokens: { increment: delta.inputTokens },
          outputTokens: { increment: delta.outputTokens },
          cachedInputTokens: { increment: delta.cachedInputTokens },
          errorCount: { increment: delta.errorCount },
        },
      }),
    ),
  );
  reconciledReservations.add(reservation.reservationId);
  if (reconciledReservations.size > 10_000) {
    const oldest = reconciledReservations.values().next().value as
      string | undefined;

    if (oldest) reconciledReservations.delete(oldest);
  }
};

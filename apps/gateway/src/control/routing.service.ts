import type { Prisma } from "../generated/prisma/client";

import { llmGatewayPrisma } from "../core/db";
import { GatewayError } from "../core/errors";

export interface RoutingMemberRow {
  id: string;
  accountId: string;
  accountLabel: string;
  enabled: boolean;
  weight: number;
  priority: number;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  maxTrafficShareBps: number | null;
  quotaRules: unknown;
}

export interface RoutingPoolRow {
  id: string;
  provider: string;
  name: string;
  policy:
    | "QUOTA_BALANCED"
    | "WEIGHTED_SHARE"
    | "LEAST_UTILIZED"
    | "PRIORITY_FAILOVER";
  enabled: boolean;
  stickySessions: boolean;
  sessionTtlSeconds: number;
  shortResetGraceSeconds: number;
  quotaMaxAgeSeconds: number;
  quotaPollIntervalSeconds: number;
  members: RoutingMemberRow[];
  modelCount: number;
}

const poolInclude = {
  members: {
    include: {
      account: {
        select: { email: true, displayName: true, externalAccountId: true },
      },
    },
    orderBy: [{ priority: "asc" as const }, { createdAt: "asc" as const }],
  },
  _count: { select: { models: true } },
};

type PoolRecord = Awaited<
  ReturnType<typeof llmGatewayPrisma.gatewayRoutingPool.findFirstOrThrow>
> & {
  members?: Array<{
    id: string;
    accountId: string;
    enabled: boolean;
    weight: number;
    priority: number;
    maxConcurrency: number | null;
    dailyRequestCap: number | null;
    dailyInputTokenCap: bigint | null;
    dailyOutputTokenCap: bigint | null;
    maxTrafficShareBps: number | null;
    quotaRules: unknown;
    account: {
      email: string | null;
      displayName: string | null;
      externalAccountId: string;
    };
  }>;
  _count?: { models: number };
};

const toPoolRow = (pool: PoolRecord): RoutingPoolRow => ({
  id: pool.id,
  provider: pool.provider,
  name: pool.name,
  policy: pool.policy,
  enabled: pool.enabled,
  stickySessions: pool.stickySessions,
  sessionTtlSeconds: pool.sessionTtlSeconds,
  shortResetGraceSeconds: pool.shortResetGraceSeconds,
  quotaMaxAgeSeconds: pool.quotaMaxAgeSeconds,
  quotaPollIntervalSeconds: pool.quotaPollIntervalSeconds,
  members: (pool.members ?? []).map((member) => ({
    id: member.id,
    accountId: member.accountId,
    accountLabel:
      member.account.displayName ??
      member.account.email ??
      member.account.externalAccountId,
    enabled: member.enabled,
    weight: member.weight,
    priority: member.priority,
    maxConcurrency: member.maxConcurrency,
    dailyRequestCap: member.dailyRequestCap,
    dailyInputTokenCap: member.dailyInputTokenCap?.toString() ?? null,
    dailyOutputTokenCap: member.dailyOutputTokenCap?.toString() ?? null,
    maxTrafficShareBps: member.maxTrafficShareBps,
    quotaRules: member.quotaRules,
  })),
  modelCount: pool._count?.models ?? 0,
});

export const listRoutingPools = async (): Promise<RoutingPoolRow[]> => {
  const pools = await llmGatewayPrisma.gatewayRoutingPool.findMany({
    include: poolInclude,
    orderBy: [{ provider: "asc" }, { name: "asc" }],
  });

  return pools.map((pool) => toPoolRow(pool as PoolRecord));
};

export interface RoutingPoolInput {
  provider: string;
  name: string;
  policy: RoutingPoolRow["policy"];
  enabled?: boolean;
  stickySessions?: boolean;
  sessionTtlSeconds?: number;
  shortResetGraceSeconds?: number;
  quotaMaxAgeSeconds?: number;
  quotaPollIntervalSeconds?: number;
}

export const createRoutingPool = async (
  input: RoutingPoolInput,
): Promise<RoutingPoolRow> => {
  const created = await llmGatewayPrisma.gatewayRoutingPool.create({
    data: {
      provider: input.provider,
      name: input.name,
      policy: input.policy,
      enabled: input.enabled ?? true,
      stickySessions: input.stickySessions ?? true,
      sessionTtlSeconds: input.sessionTtlSeconds ?? 604_800,
      shortResetGraceSeconds: input.shortResetGraceSeconds ?? 900,
      quotaMaxAgeSeconds: input.quotaMaxAgeSeconds ?? 900,
      quotaPollIntervalSeconds: input.quotaPollIntervalSeconds ?? 300,
    },
    include: poolInclude,
  });

  return toPoolRow(created as PoolRecord);
};

export const updateRoutingPool = async (
  id: string,
  input: Partial<Omit<RoutingPoolInput, "provider">>,
): Promise<RoutingPoolRow> => {
  const existing = await llmGatewayPrisma.gatewayRoutingPool.findUnique({
    where: { id },
  });

  if (!existing)
    throw new GatewayError("Routing pool not found", 404, "NOT_FOUND");
  const updated = await llmGatewayPrisma.gatewayRoutingPool.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.policy !== undefined && { policy: input.policy }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.stickySessions !== undefined && {
        stickySessions: input.stickySessions,
      }),
      ...(input.sessionTtlSeconds !== undefined && {
        sessionTtlSeconds: input.sessionTtlSeconds,
      }),
      ...(input.shortResetGraceSeconds !== undefined && {
        shortResetGraceSeconds: input.shortResetGraceSeconds,
      }),
      ...(input.quotaMaxAgeSeconds !== undefined && {
        quotaMaxAgeSeconds: input.quotaMaxAgeSeconds,
      }),
      ...(input.quotaPollIntervalSeconds !== undefined && {
        quotaPollIntervalSeconds: input.quotaPollIntervalSeconds,
      }),
    },
    include: poolInclude,
  });

  return toPoolRow(updated as PoolRecord);
};

export const deleteRoutingPool = async (
  id: string,
): Promise<RoutingPoolRow> => {
  const existing = await llmGatewayPrisma.gatewayRoutingPool.findUnique({
    where: { id },
    include: poolInclude,
  });

  if (!existing)
    throw new GatewayError("Routing pool not found", 404, "NOT_FOUND");
  if (existing._count.models > 0) {
    throw new GatewayError(
      "Move models out of this pool before deleting it",
      409,
      "POOL_IN_USE",
    );
  }
  await llmGatewayPrisma.gatewayRoutingPool.delete({ where: { id } });

  return toPoolRow(existing as PoolRecord);
};

export interface RoutingMemberInput {
  accountId: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
  maxConcurrency?: number | null;
  dailyRequestCap?: number | null;
  dailyInputTokenCap?: bigint | null;
  dailyOutputTokenCap?: bigint | null;
  maxTrafficShareBps?: number | null;
  quotaRules?: object | null;
}

export interface TrafficShareCeilingMember {
  enabled: boolean;
  maxTrafficShareBps: number | null;
}

/**
 * If every enabled member is capped, their ceilings must collectively cover
 * 100% of traffic. Otherwise the pool inevitably reaches a state in which no
 * member can accept the next request. An uncapped member provides the required
 * residual capacity; an empty pool remains a valid staged configuration.
 */
export const assertFeasibleTrafficShareCeilings = (
  members: readonly TrafficShareCeilingMember[],
): void => {
  const enabledMembers = members.filter((member) => member.enabled);

  if (
    enabledMembers.length === 0 ||
    enabledMembers.some((member) => member.maxTrafficShareBps === null)
  ) {
    return;
  }
  const totalCeilingBps = enabledMembers.reduce(
    (total, member) => total + member.maxTrafficShareBps!,
    0,
  );

  if (totalCeilingBps < 10_000) {
    throw new GatewayError(
      `Enabled member traffic-share ceilings total ${totalCeilingBps} bps; configure at least 10000 bps (100%) or leave one member uncapped`,
      400,
      "INFEASIBLE_TRAFFIC_SHARE_CEILINGS",
    );
  }
};

export const lockRoutingPool = async (
  tx: Prisma.TransactionClient,
  poolId: string,
): Promise<void> => {
  await tx.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(
      hashtextextended(${`llm-gateway-routing-pool:${poolId}`}, 0)
    )
  `;
};

/** Validate the effective capacity after an account is disabled or removed. */
export const assertAccountRemovalKeepsTrafficSharesFeasible = async (
  accountId: string,
  tx: Prisma.TransactionClient,
): Promise<void> => {
  const memberships = await tx.gatewayRoutingPoolMember.findMany({
    where: { accountId },
    select: { routingPoolId: true },
  });
  const poolIds = [
    ...new Set(memberships.map((item) => item.routingPoolId)),
  ].sort();

  for (const poolId of poolIds) {
    await lockRoutingPool(tx, poolId);
    const remaining = await tx.gatewayRoutingPoolMember.findMany({
      where: {
        routingPoolId: poolId,
        accountId: { not: accountId },
        account: { enabled: true },
      },
      select: { enabled: true, maxTrafficShareBps: true },
    });

    assertFeasibleTrafficShareCeilings(remaining);
  }
};

const assertPoolAccountProvider = async (poolId: string, accountId: string) => {
  const [pool, account] = await Promise.all([
    llmGatewayPrisma.gatewayRoutingPool.findUnique({ where: { id: poolId } }),
    llmGatewayPrisma.gatewayProviderAccount.findUnique({
      where: { id: accountId },
    }),
  ]);

  if (!pool) throw new GatewayError("Routing pool not found", 404, "NOT_FOUND");
  if (!account) throw new GatewayError("Account not found", 404, "NOT_FOUND");
  if (pool.provider !== account.provider) {
    throw new GatewayError(
      "Pool and account providers must match",
      400,
      "PROVIDER_MISMATCH",
    );
  }
};

const effectiveTrafficShareMembers = async (
  tx: Prisma.TransactionClient,
  poolId: string,
) =>
  tx.gatewayRoutingPoolMember.findMany({
    where: { routingPoolId: poolId },
    select: {
      id: true,
      accountId: true,
      enabled: true,
      maxTrafficShareBps: true,
      account: { select: { enabled: true } },
    },
  });

export const createRoutingMember = async (
  poolId: string,
  input: RoutingMemberInput,
): Promise<RoutingPoolRow> => {
  await assertPoolAccountProvider(poolId, input.accountId);
  const pool = await llmGatewayPrisma.$transaction(
    async (tx) => {
      await lockRoutingPool(tx, poolId);
      const [members, account] = await Promise.all([
        effectiveTrafficShareMembers(tx, poolId),
        tx.gatewayProviderAccount.findUniqueOrThrow({
          where: { id: input.accountId },
          select: { enabled: true },
        }),
      ]);

      assertFeasibleTrafficShareCeilings([
        ...members.map((member) => ({
          enabled: member.enabled && member.account.enabled,
          maxTrafficShareBps: member.maxTrafficShareBps,
        })),
        {
          enabled: (input.enabled ?? true) && account.enabled,
          maxTrafficShareBps: input.maxTrafficShareBps ?? null,
        },
      ]);
      await tx.gatewayRoutingPoolMember.create({
        data: {
          routingPoolId: poolId,
          accountId: input.accountId,
          enabled: input.enabled ?? true,
          weight: input.weight ?? 100,
          priority: input.priority ?? 100,
          maxConcurrency: input.maxConcurrency,
          dailyRequestCap: input.dailyRequestCap,
          dailyInputTokenCap: input.dailyInputTokenCap,
          dailyOutputTokenCap: input.dailyOutputTokenCap,
          maxTrafficShareBps: input.maxTrafficShareBps,
          quotaRules: input.quotaRules ?? undefined,
        },
      });

      return tx.gatewayRoutingPool.findUniqueOrThrow({
        where: { id: poolId },
        include: poolInclude,
      });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return toPoolRow(pool as PoolRecord);
};

export const updateRoutingMember = async (
  poolId: string,
  memberId: string,
  input: Partial<Omit<RoutingMemberInput, "accountId">>,
): Promise<RoutingPoolRow> => {
  const pool = await llmGatewayPrisma.$transaction(
    async (tx) => {
      await lockRoutingPool(tx, poolId);
      const members = await effectiveTrafficShareMembers(tx, poolId);
      const existing = members.find((member) => member.id === memberId);

      if (!existing)
        throw new GatewayError("Routing member not found", 404, "NOT_FOUND");
      assertFeasibleTrafficShareCeilings(
        members.map((member) =>
          member.id === memberId
            ? {
                enabled:
                  (input.enabled ?? member.enabled) && member.account.enabled,
                maxTrafficShareBps:
                  input.maxTrafficShareBps === undefined
                    ? member.maxTrafficShareBps
                    : input.maxTrafficShareBps,
              }
            : {
                enabled: member.enabled && member.account.enabled,
                maxTrafficShareBps: member.maxTrafficShareBps,
              },
        ),
      );
      await tx.gatewayRoutingPoolMember.update({
        where: { id: memberId },
        data: {
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.weight !== undefined && { weight: input.weight }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.maxConcurrency !== undefined && {
            maxConcurrency: input.maxConcurrency,
          }),
          ...(input.dailyRequestCap !== undefined && {
            dailyRequestCap: input.dailyRequestCap,
          }),
          ...(input.dailyInputTokenCap !== undefined && {
            dailyInputTokenCap: input.dailyInputTokenCap,
          }),
          ...(input.dailyOutputTokenCap !== undefined && {
            dailyOutputTokenCap: input.dailyOutputTokenCap,
          }),
          ...(input.maxTrafficShareBps !== undefined && {
            maxTrafficShareBps: input.maxTrafficShareBps,
          }),
          ...(input.quotaRules !== undefined && {
            quotaRules: input.quotaRules ?? undefined,
          }),
        },
      });

      return tx.gatewayRoutingPool.findUniqueOrThrow({
        where: { id: poolId },
        include: poolInclude,
      });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return toPoolRow(pool as PoolRecord);
};

export const deleteRoutingMember = async (
  poolId: string,
  memberId: string,
): Promise<RoutingPoolRow> => {
  const pool = await llmGatewayPrisma.$transaction(
    async (tx) => {
      await lockRoutingPool(tx, poolId);
      const members = await effectiveTrafficShareMembers(tx, poolId);

      if (!members.some((member) => member.id === memberId)) {
        throw new GatewayError("Routing member not found", 404, "NOT_FOUND");
      }
      assertFeasibleTrafficShareCeilings(
        members
          .filter((member) => member.id !== memberId)
          .map((member) => ({
            enabled: member.enabled && member.account.enabled,
            maxTrafficShareBps: member.maxTrafficShareBps,
          })),
      );
      await tx.gatewayRoutingPoolMember.delete({ where: { id: memberId } });

      return tx.gatewayRoutingPool.findUniqueOrThrow({
        where: { id: poolId },
        include: poolInclude,
      });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return toPoolRow(pool as PoolRecord);
};

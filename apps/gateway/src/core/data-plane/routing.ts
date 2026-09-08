import type { GatewayClientPrincipal } from "../../control/client-keys.service";
import type { RoutingMemberCandidate, RoutingPolicy } from "../routing/types";

import {
  accountUsageWindowStart,
  reconcileAccountUsageReservation,
  reserveAccountDailyCapacity,
  routingPoolAccountUsageScopeId,
  routingPoolUsageScopePrefix,
  strictestAccountCap,
  type GatewayAccountDailyCaps,
  type GatewayAccountUsageReservation,
} from "../account-usage";
import { llmGatewayPrisma } from "../db";
import { GatewayError } from "../errors";
import {
  countActiveLeases,
  type LeaseGuard,
  releaseLease,
  tryAcquireConcurrencyLease,
  type LeaseHandle,
} from "../leases";
import type { QuotaSnapshot } from "../providers";
import type { ProviderIdentity } from "../providers/types";
import { fromDbProvider } from "../providers/provider-id";
import { selectRoutingAccount } from "../routing/engine";
import { hmacGatewaySession } from "../security/secrets";

const LEASE_TTL_MS = 120_000;
const MAX_SESSION_ID_LENGTH = 256;

export const parseGatewayQuotaRules = (
  value: unknown,
): { maxUsedRatio: number | null; reserveRatio: number | null } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { maxUsedRatio: null, reserveRatio: null };
  }
  const record = value as Record<string, unknown>;
  // Canonical storage/API representation is integer basis points. Legacy
  // ratio keys remain readable so existing rows keep their intended policy.
  const maxUsedRatio =
    typeof record.maxUtilizationBps === "number"
      ? record.maxUtilizationBps / 10_000
      : typeof record.maxUsedRatio === "number"
        ? record.maxUsedRatio
        : null;
  const reserveRatio =
    typeof record.reserveBps === "number"
      ? record.reserveBps / 10_000
      : typeof record.reserveRatio === "number"
        ? record.reserveRatio
        : null;

  return { maxUsedRatio, reserveRatio };
};

interface RoutingQuotaSnapshot {
  meterKey: string;
  windowKey: string;
  observedAt: Date;
  source: string;
}

/**
 * Select the active quota generation for routing. A provider poll is a complete
 * snapshot, so response-header observations older than the newest poll cannot
 * keep an omitted window stale forever. Newer response headers still augment
 * or supersede the poll until the next complete refresh.
 */
export const currentRoutingQuotaSnapshots = <T extends RoutingQuotaSnapshot>(
  snapshots: T[],
): T[] => {
  const latestPollAt = snapshots.reduce<number | null>(
    (latest, snapshot) =>
      snapshot.source === "POLL"
        ? Math.max(
            latest ?? Number.NEGATIVE_INFINITY,
            snapshot.observedAt.getTime(),
          )
        : latest,
    null,
  );
  const latestByWindow = new Map<string, T>();

  for (const snapshot of snapshots) {
    if (
      snapshot.source === "RESPONSE_HEADER" &&
      latestPollAt !== null &&
      snapshot.observedAt.getTime() < latestPollAt
    ) {
      continue;
    }
    const key = `${snapshot.meterKey}:${snapshot.windowKey}`;
    const current = latestByWindow.get(key);

    if (!current || snapshot.observedAt > current.observedAt) {
      latestByWindow.set(key, snapshot);
    }
  }

  return [...latestByWindow.values()];
};

const policyName = (policy: string): RoutingPolicy => {
  switch (policy) {
    case "WEIGHTED_SHARE":
      return "weighted_share";
    case "LEAST_UTILIZED":
      return "least_utilized";
    case "PRIORITY_FAILOVER":
      return "priority_failover";
    default:
      return "quota_balanced";
  }
};

const strictestNumberCap = (
  memberCap: number | null,
  accountCap: number | null,
): number | null => {
  if (memberCap === null) return accountCap;
  if (accountCap === null) return memberCap;

  return Math.min(memberCap, accountCap);
};

type LoadedPool = Awaited<ReturnType<typeof loadRoutingCandidates>>;

const loadRoutingCandidates = async (
  model: { id: string; routingPoolId: string | null },
  now: Date,
  excludedAccountIds: Set<string>,
) => {
  if (!model.routingPoolId) {
    throw new GatewayError(
      "Model has no routing pool",
      503,
      "MODEL_NOT_ROUTED",
    );
  }
  const pool = await llmGatewayPrisma.gatewayRoutingPool.findUnique({
    where: { id: model.routingPoolId },
    include: {
      members: {
        where: { enabled: true, accountId: { notIn: [...excludedAccountIds] } },
        include: {
          account: {
            include: {
              accountModels: {
                where: {
                  modelId: model.id,
                  lastSeenAt: {
                    gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
                  },
                },
                select: { available: true, lastSeenAt: true },
              },
              quotaSnapshots: {
                where: { OR: [{ modelId: null }, { modelId: model.id }] },
                orderBy: { observedAt: "desc" },
              },
            },
          },
        },
      },
    },
  });

  if (!pool?.enabled)
    throw new GatewayError(
      "Routing pool is unavailable",
      503,
      "POOL_UNAVAILABLE",
    );
  const accountIds = pool.members.map((member) => member.accountId);
  const poolUsageScopeByAccount = new Map(
    accountIds.map((accountId) => [
      accountId,
      routingPoolAccountUsageScopeId(pool.id, accountId),
    ]),
  );
  const accountByPoolUsageScope = new Map(
    [...poolUsageScopeByAccount].map(([accountId, scopeId]) => [
      scopeId,
      accountId,
    ]),
  );
  const usageRows = accountIds.length
    ? await llmGatewayPrisma.gatewayUsageBucket.findMany({
        where: {
          scopeType: "ROUTING_POOL",
          // Include recently disabled/deleted/retry-excluded members in the
          // pool denominator. Their historical requests still contributed to
          // the shares that current candidates must be measured against.
          scopeId: { startsWith: routingPoolUsageScopePrefix(pool.id) },
          bucketStart: { gte: accountUsageWindowStart(now) },
        },
      })
    : [];
  const usageByAccount = new Map<
    string,
    { requests: number; input: bigint; output: bigint }
  >();
  let totalRequests = 0;

  for (const row of usageRows) {
    totalRequests += row.requestCount;
    const accountId = accountByPoolUsageScope.get(row.scopeId);

    if (!accountId) continue;
    const aggregate = usageByAccount.get(accountId) ?? {
      requests: 0,
      input: 0n,
      output: 0n,
    };

    aggregate.requests += row.requestCount;
    aggregate.input += row.inputTokens;
    aggregate.output += row.outputTokens;
    usageByAccount.set(accountId, aggregate);
  }
  const candidates: RoutingMemberCandidate[] = [];
  const accountCapsByAccount = new Map<string, GatewayAccountDailyCaps>();
  const memberCapsByAccount = new Map<string, GatewayAccountDailyCaps>();

  for (const member of pool.members) {
    const account = member.account;
    const usage = usageByAccount.get(member.accountId) ?? {
      requests: 0,
      input: 0n,
      output: 0n,
    };
    const activeConcurrency = await countActiveLeases(
      "ACCOUNT_CONCURRENCY",
      member.accountId,
      now,
    );
    const currentQuota = currentRoutingQuotaSnapshots(account.quotaSnapshots);
    // Candidate freshness is the oldest retained current window. A fresh
    // empty/partial poll must not make a stale provider limit look fresh.
    const observedAt = currentQuota.reduce<Date | null>(
      (oldest, item) =>
        !oldest || item.observedAt < oldest ? item.observedAt : oldest,
      null,
    );
    const rules = parseGatewayQuotaRules(member.quotaRules);
    const dailyRequestCap = strictestNumberCap(
      member.dailyRequestCap,
      account.dailyRequestCap,
    );
    const dailyInputTokenCap = strictestAccountCap(
      member.dailyInputTokenCap,
      account.dailyInputTokenCap,
    );
    const dailyOutputTokenCap = strictestAccountCap(
      member.dailyOutputTokenCap,
      account.dailyOutputTokenCap,
    );

    accountCapsByAccount.set(account.id, {
      requests: account.dailyRequestCap,
      inputTokens: account.dailyInputTokenCap,
      outputTokens: account.dailyOutputTokenCap,
    });
    memberCapsByAccount.set(account.id, {
      requests: member.dailyRequestCap,
      inputTokens: member.dailyInputTokenCap,
      outputTokens: member.dailyOutputTokenCap,
    });

    const transportConfigured =
      account.transportMode === "direct" ||
      (account.transportMode === "agent-sdk" &&
        Boolean(account.transportProfileId));

    candidates.push({
      accountId: account.id,
      provider: fromDbProvider(account.provider),
      enabled: account.enabled && member.enabled && transportConfigured,
      supportsModel: account.accountModels.some((item) => item.available),
      health:
        account.status === "REAUTH_REQUIRED"
          ? "reauth_required"
          : account.enabled
            ? account.status === "ERROR"
              ? "degraded"
              : "healthy"
            : "disabled",
      weight: member.weight,
      priority: member.priority,
      maxConcurrency: member.maxConcurrency ?? account.maxConcurrency,
      activeConcurrency,
      dailyRequestCap,
      dailyInputTokenCap:
        dailyInputTokenCap === null ? null : Number(dailyInputTokenCap),
      dailyOutputTokenCap:
        dailyOutputTokenCap === null ? null : Number(dailyOutputTokenCap),
      requestsLast24h: usage.requests,
      inputTokensLast24h: Number(usage.input),
      outputTokensLast24h: Number(usage.output),
      maxTrafficShareBps: member.maxTrafficShareBps,
      trafficShareBps:
        totalRequests > 0
          ? Math.round((usage.requests / totalRequests) * 10_000)
          : 0,
      maxUsedRatio: rules.maxUsedRatio,
      reserveRatio: rules.reserveRatio,
      quotaObservedAt: observedAt,
      quotaWindows: currentQuota.map((quota) => ({
        id: `${quota.meterKey}:${quota.windowKey}`,
        usedRatio:
          quota.utilizationBps === null ? null : quota.utilizationBps / 10_000,
        remaining: quota.remaining,
        limit: quota.limit,
        resetAt: quota.resetAt,
      })),
      cooldownUntil: account.cooldownUntil,
    });
  }

  return {
    pool,
    candidates,
    usageByAccount,
    accountCapsByAccount,
    memberCapsByAccount,
  };
};

export const normalizedSessionId = (
  header: string | undefined,
): string | null => {
  const value = header?.trim();

  if (!value) return null;
  if (value.length > MAX_SESSION_ID_LENGTH || !/^[\x20-\x7e]+$/.test(value)) {
    throw new GatewayError(
      "Invalid Claude Code session ID",
      400,
      "INVALID_SESSION_ID",
    );
  }

  return value;
};

export const acquireClientLease = async (
  principal: GatewayClientPrincipal,
): Promise<LeaseHandle> => {
  const lease = await tryAcquireConcurrencyLease({
    kind: "CLIENT_CONCURRENCY",
    resourceId: principal.id,
    maxConcurrency: principal.maxConcurrency,
    ttlMs: LEASE_TTL_MS,
  });

  if (!lease)
    throw new GatewayError(
      "Client concurrency limit reached",
      429,
      "CLIENT_CONCURRENCY",
    );

  return lease;
};

export interface RoutedAccount {
  pool: LoadedPool["pool"];
  accountId: string;
  accountLease: LeaseHandle;
  usageReservation: GatewayAccountUsageReservation;
  sessionHash: string | null;
  identity: ProviderIdentity;
  transport:
    | { id: "direct" }
    | { id: "agent-sdk"; profileId: string; tokenBacked?: boolean };
}

export const routeAccount = async (input: {
  model: { id: string; publicModelId: string; routingPoolId: string | null };
  principal: GatewayClientPrincipal;
  sessionId: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  retry: boolean;
  excludedAccountIds: Set<string>;
  requestKey: string;
  leaseGuard?: LeaseGuard;
}): Promise<RoutedAccount> => {
  input.leaseGuard?.throwIfFailed();
  const now = new Date();
  const loaded = await loadRoutingCandidates(
    input.model,
    now,
    input.excludedAccountIds,
  );
  const sessionHash = input.sessionId
    ? hmacGatewaySession(input.sessionId)
    : null;
  const existing = sessionHash
    ? await llmGatewayPrisma.gatewaySessionRoute.findUnique({
        where: {
          clientKeyId_sessionHash_modelId: {
            clientKeyId: input.principal.id,
            sessionHash,
            modelId: input.model.id,
          },
        },
      })
    : null;
  const selection = selectRoutingAccount({
    policy: policyName(loaded.pool.policy),
    members: loaded.candidates,
    now,
    modelId: input.model.publicModelId,
    requestKey: input.requestKey,
    stickyAccountId:
      existing && existing.expiresAt > now ? existing.accountId : null,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    quotaMaxAgeMs: loaded.pool.quotaMaxAgeSeconds * 1_000,
    shortResetGraceMs: loaded.pool.shortResetGraceSeconds * 1_000,
  });

  if (selection.kind === "hold") {
    throw new GatewayError(
      "The session account is briefly quota-limited; retry to preserve prompt cache",
      429,
      "SESSION_QUOTA_HOLD",
      selection.retryAt,
    );
  }
  if (selection.kind === "unavailable") {
    if (selection.reason === "quota_exhausted") {
      const reset = selection.retryAt
        ? ` Resets at ${selection.retryAt.toISOString()}.`
        : "";

      throw new GatewayError(
        `Subscription quota is fully used.${reset}`,
        400,
        "SUBSCRIPTION_QUOTA_EXHAUSTED",
      );
    }
    throw new GatewayError(
      selection.reason === "quota"
        ? "All eligible subscription accounts are quota-limited"
        : "No eligible subscription account is available",
      selection.reason === "quota" ? 429 : 503,
      selection.reason === "quota"
        ? "ALL_ACCOUNTS_QUOTA_LIMITED"
        : "NO_ACCOUNT_AVAILABLE",
      selection.retryAt ?? undefined,
    );
  }

  const candidate = loaded.candidates.find(
    (item) => item.accountId === selection.accountId,
  )!;
  const selectedAccount = loaded.pool.members.find(
    (member) => member.accountId === selection.accountId,
  )!.account;
  const accountLease = await tryAcquireConcurrencyLease({
    kind: "ACCOUNT_CONCURRENCY",
    resourceId: selection.accountId,
    maxConcurrency: candidate.maxConcurrency,
    ttlMs: LEASE_TTL_MS,
  });

  if (!accountLease) {
    input.excludedAccountIds.add(selection.accountId);

    return routeAccount(input);
  }
  input.leaseGuard?.addLease(accountLease);
  input.leaseGuard?.throwIfFailed();

  let usageReservation: GatewayAccountUsageReservation;

  try {
    usageReservation = await reserveAccountDailyCapacity({
      accountId: selection.accountId,
      routingPoolId: loaded.pool.id,
      modelId: input.model.id,
      accountCaps: loaded.accountCapsByAccount.get(selection.accountId)!,
      memberCaps: loaded.memberCapsByAccount.get(selection.accountId)!,
      maxTrafficShareBps: candidate.maxTrafficShareBps,
      estimatedInputTokens: input.estimatedInputTokens,
      requestedOutputTokens: input.estimatedOutputTokens,
      retry: input.retry,
      now,
    });
  } catch (error) {
    if (input.leaseGuard) await input.leaseGuard.releaseLease(accountLease);
    else await releaseLease(accountLease);
    if (
      error instanceof GatewayError &&
      (error.code === "ACCOUNT_DAILY_CAP" ||
        error.code === "ROUTING_MEMBER_DAILY_CAP" ||
        error.code === "TRAFFIC_SHARE_CAP")
    ) {
      input.excludedAccountIds.add(selection.accountId);

      return routeAccount(input);
    }
    throw error;
  }

  try {
    if (loaded.pool.stickySessions && sessionHash) {
      await llmGatewayPrisma.gatewaySessionRoute.upsert({
        where: {
          clientKeyId_sessionHash_modelId: {
            clientKeyId: input.principal.id,
            sessionHash,
            modelId: input.model.id,
          },
        },
        create: {
          clientKeyId: input.principal.id,
          sessionHash,
          modelId: input.model.id,
          routingPoolId: loaded.pool.id,
          accountId: selection.accountId,
          expiresAt: new Date(
            now.getTime() + loaded.pool.sessionTtlSeconds * 1_000,
          ),
        },
        update: {
          routingPoolId: loaded.pool.id,
          accountId: selection.accountId,
          lastUsedAt: now,
          expiresAt: new Date(
            now.getTime() + loaded.pool.sessionTtlSeconds * 1_000,
          ),
        },
      });
    }
  } catch (error) {
    await Promise.allSettled([
      input.leaseGuard
        ? input.leaseGuard.releaseLease(accountLease)
        : releaseLease(accountLease),
      reconcileAccountUsageReservation(usageReservation, {
        inputTokens: input.estimatedInputTokens,
        outputTokens: 0,
        error: true,
      }),
    ]);
    throw error;
  }

  return {
    pool: loaded.pool,
    accountId: selection.accountId,
    accountLease,
    usageReservation,
    sessionHash,
    identity: {
      externalAccountId: selectedAccount.externalAccountId,
      ...(selectedAccount.externalWorkspaceId
        ? { externalWorkspaceId: selectedAccount.externalWorkspaceId }
        : {}),
      ...(selectedAccount.email ? { email: selectedAccount.email } : {}),
      ...(selectedAccount.displayName
        ? { displayName: selectedAccount.displayName }
        : {}),
      ...(selectedAccount.planType ? { plan: selectedAccount.planType } : {}),
    },
    transport:
      selectedAccount.transportMode === "agent-sdk"
        ? {
            id: "agent-sdk",
            profileId: selectedAccount.transportProfileId!,
            tokenBacked: selectedAccount.authenticationMethod === "oauth-token",
          }
        : { id: "direct" },
  };
};

export const persistGatewayHeaderQuota = async (
  accountId: string,
  modelId: string,
  snapshot: QuotaSnapshot,
): Promise<void> => {
  if (snapshot.windows.length === 0) return;
  const origin = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
    where: { id: accountId },
    select: {
      provider: true,
      authenticationMethod: true,
      externalWorkspaceId: true,
    },
  });
  if (!origin) return;
  const org = snapshot.metadata?.organizationId;
  if (
    origin.authenticationMethod === "oauth-token" &&
    typeof org === "string" &&
    /^[0-9a-f-]{36}$/i.test(org)
  ) {
    // Header belongs to an adapter-owned upstream response, never caller input.
    await llmGatewayPrisma.gatewayProviderAccount.update({
      where: { id: accountId },
      data: { externalWorkspaceId: org },
    });
    origin.externalWorkspaceId = org;
  }
  // Organization membership alone does not establish shared subscription quota.
  await persistAccountHeaderQuota(accountId, modelId, snapshot);
};

const persistAccountHeaderQuota = async (
  accountId: string,
  modelId: string,
  snapshot: QuotaSnapshot,
): Promise<void> => {
  const data = snapshot.windows.map((window) => ({
    accountId,
    // Provider-wide headers (Claude unified windows, Codex primary/
    // secondary windows) apply to every model on the account. Only an
    // explicitly model-scoped observation is attached to this model.
    modelId: window.scope ? modelId : null,
    meterKey: window.meterKey ?? window.scope ?? "chat",
    windowKey: window.id,
    used: window.usedFraction,
    remaining: window.remainingFraction,
    // Header parsers expose a ratio, not an absolute token allowance.
    limit: null,
    utilizationBps:
      window.allowed === false || window.limitReached === true
        ? 10_000
        : window.usedFraction === undefined
          ? null
          : Math.round(Math.max(0, Math.min(1, window.usedFraction)) * 10_000),
    resetAt: window.resetsAt ? new Date(window.resetsAt) : null,
    source: "RESPONSE_HEADER" as const,
    observedAt: new Date(window.observedAt ?? snapshot.fetchedAt),
  }));

  await llmGatewayPrisma.$transaction(
    async (tx) => {
      // Serialize per-account compaction across replicas. Keeping exactly the
      // latest observation per header window prevents frequent global headers
      // from crowding infrequent model-scoped POLL limits out of routing.
      await tx.$queryRaw`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-header-quota:${accountId}`}, 0)
        )
      `;
      const existingRows = await tx.gatewayQuotaSnapshot.findMany({
        where: {
          accountId,
          source: "RESPONSE_HEADER",
          OR: data.map((row) => ({
            modelId: row.modelId,
            meterKey: row.meterKey,
            windowKey: row.windowKey,
          })),
        },
        orderBy: { observedAt: "desc" },
        select: {
          modelId: true,
          meterKey: true,
          windowKey: true,
          utilizationBps: true,
          observedAt: true,
        },
      });
      const quotaKey = (row: {
        modelId: string | null;
        meterKey: string;
        windowKey: string;
      }) => JSON.stringify([row.modelId, row.meterKey, row.windowKey]);
      const latestByKey = new Map<string, (typeof existingRows)[number]>();

      for (const row of existingRows) {
        const key = quotaKey(row);

        if (!latestByKey.has(key)) latestByKey.set(key, row);
      }
      const accepted = data.filter((row) => {
        const current = latestByKey.get(quotaKey(row));

        if (!current) return true;
        const timeDelta =
          row.observedAt.getTime() - current.observedAt.getTime();

        if (timeDelta !== 0) return timeDelta > 0;

        // Equal timestamps can occur on concurrent same-millisecond responses;
        // retain the more conservative observation rather than reopening quota.
        return (row.utilizationBps ?? -1) >= (current.utilizationBps ?? -1);
      });

      if (accepted.length === 0) return;
      await tx.gatewayQuotaSnapshot.deleteMany({
        where: {
          accountId,
          source: "RESPONSE_HEADER",
          OR: accepted.map((row) => ({
            modelId: row.modelId,
            meterKey: row.meterKey,
            windowKey: row.windowKey,
          })),
        },
      });
      await tx.gatewayQuotaSnapshot.createMany({ data: accepted });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );
};

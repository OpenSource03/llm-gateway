import Logger from "../config/logger";
import { getEnv } from "../config/env";
import { refreshGatewayAccount } from "../control/accounts.service";

import { llmGatewayPrisma } from "./db";
import {
  deleteExpiredLeases,
  heartbeatLease,
  releaseLease,
  tryAcquireLease,
} from "./leases";

const REFRESH_TICK_MS = 60_000;
const HOUSEKEEPING_TICK_MS = 60 * 60 * 1000;
const GLOBAL_REFRESH_LEASE_MS = 4 * 60 * 1000;
const GLOBAL_HOUSEKEEPING_LEASE_MS = 15 * 60 * 1000;

interface SchedulerState {
  started: boolean;
  refreshing: boolean;
  housekeeping: boolean;
  refreshTimer?: ReturnType<typeof setInterval>;
  housekeepingTimer?: ReturnType<typeof setInterval>;
}

const globalScheduler = globalThis as typeof globalThis & {
  __llmGatewayScheduler?: SchedulerState;
};

const state = (): SchedulerState => {
  globalScheduler.__llmGatewayScheduler ??= {
    started: false,
    refreshing: false,
    housekeeping: false,
  };

  return globalScheduler.__llmGatewayScheduler;
};

const logJobFailure = (job: string, error: unknown): void => {
  // Provider responses and token material are intentionally never logged.
  Logger.warn("LLM gateway background job failed", {
    job,
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
};

/** Refresh due account quotas and model catalogs once across all replicas. */
export const refreshDueGatewayAccounts = async (
  now = new Date(),
): Promise<number> => {
  const globalLease = await tryAcquireLease({
    kind: "QUOTA_REFRESH",
    resourceId: "global",
    ttlMs: GLOBAL_REFRESH_LEASE_MS,
    now,
  });

  if (!globalLease) return 0;
  const heartbeat = setInterval(() => {
    void heartbeatLease(globalLease, GLOBAL_REFRESH_LEASE_MS).catch(
      () => undefined,
    );
  }, 60_000);

  heartbeat.unref?.();
  try {
    const accounts = await llmGatewayPrisma.gatewayProviderAccount.findMany({
      where: { enabled: true, status: { not: "REAUTH_REQUIRED" } },
      select: {
        id: true,
        lastQuotaRefreshAt: true,
        poolMemberships: {
          where: { enabled: true, routingPool: { enabled: true } },
          select: {
            routingPool: { select: { quotaPollIntervalSeconds: true } },
          },
        },
      },
    });
    const due = accounts.filter((account) => {
      const intervalSeconds = account.poolMemberships.reduce(
        (minimum, membership) =>
          Math.min(minimum, membership.routingPool.quotaPollIntervalSeconds),
        300,
      );

      return (
        !account.lastQuotaRefreshAt ||
        now.getTime() - account.lastQuotaRefreshAt.getTime() >=
          intervalSeconds * 1_000
      );
    });

    // Keep upstream auth/model endpoints calm and predictable. Per-account
    // refresh locks still protect an operator-triggered refresh on another
    // replica while this loop is running.
    for (const account of due) {
      try {
        await refreshGatewayAccount(account.id);
      } catch (error) {
        Logger.warn("LLM gateway account refresh failed", {
          accountId: account.id,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    return due.length;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(globalLease);
  }
};

/** Apply bounded retention and clear expired coordination/session state. */
export const runGatewayHousekeeping = async (
  now = new Date(),
): Promise<void> => {
  const globalLease = await tryAcquireLease({
    kind: "HOUSEKEEPING",
    resourceId: "global",
    ttlMs: GLOBAL_HOUSEKEEPING_LEASE_MS,
    now,
  });

  if (!globalLease) return;
  const heartbeat = setInterval(() => {
    void heartbeatLease(globalLease, GLOBAL_HOUSEKEEPING_LEASE_MS).catch(
      () => undefined,
    );
  }, 60_000);

  heartbeat.unref?.();
  try {
    const env = getEnv();
    const historyCutoff = new Date(
      now.getTime() - env.GATEWAY_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    const oauthCutoff = new Date(
      now.getTime() - env.GATEWAY_OAUTH_RETENTION_HOURS * 60 * 60 * 1_000,
    );

    await llmGatewayPrisma.gatewayOAuthAttempt.updateMany({
      where: { status: "PENDING", expiresAt: { lte: now } },
      data: { status: "EXPIRED", failureCode: "expired" },
    });
    await Promise.all([
      llmGatewayPrisma.gatewaySessionRoute.deleteMany({
        where: { expiresAt: { lte: now } },
      }),
      llmGatewayPrisma.gatewayOAuthAttempt.deleteMany({
        where: { expiresAt: { lte: oauthCutoff } },
      }),
      llmGatewayPrisma.gatewayRequestLog.deleteMany({
        where: { startedAt: { lt: historyCutoff } },
      }),
      llmGatewayPrisma.gatewayUsageBucket.deleteMany({
        where: { bucketStart: { lt: historyCutoff } },
      }),
      llmGatewayPrisma.gatewayQuotaSnapshot.deleteMany({
        where: { observedAt: { lt: historyCutoff } },
      }),
      llmGatewayPrisma.gatewayControlAuditLog.deleteMany({
        where: { createdAt: { lt: historyCutoff } },
      }),
      deleteExpiredLeases(now),
    ]);
  } finally {
    clearInterval(heartbeat);
    await releaseLease(globalLease);
  }
};

const invokeRefresh = (): void => {
  const scheduler = state();

  if (scheduler.refreshing) return;
  scheduler.refreshing = true;
  void refreshDueGatewayAccounts()
    .catch((error) => logJobFailure("quota-and-model-refresh", error))
    .finally(() => {
      scheduler.refreshing = false;
    });
};

const invokeHousekeeping = (): void => {
  const scheduler = state();

  if (scheduler.housekeeping) return;
  scheduler.housekeeping = true;
  void runGatewayHousekeeping()
    .catch((error) => logJobFailure("housekeeping", error))
    .finally(() => {
      scheduler.housekeeping = false;
    });
};

/**
 * Lazily starts replica-local timers after the feature gate succeeds. Database
 * leases elect one replica for each job, so App Service scale-out is safe.
 */
export const touchGatewayScheduler = (): void => {
  const scheduler = state();

  if (scheduler.started) return;
  scheduler.started = true;
  scheduler.refreshTimer = setInterval(invokeRefresh, REFRESH_TICK_MS);
  scheduler.housekeepingTimer = setInterval(
    invokeHousekeeping,
    HOUSEKEEPING_TICK_MS,
  );
  scheduler.refreshTimer.unref?.();
  scheduler.housekeepingTimer.unref?.();

  invokeRefresh();
  invokeHousekeeping();
};

import type { ActorReference } from "../middleware/control-principal";
import type { Prisma } from "../generated/prisma/client";
import type {
  DiscoveredModel,
  ExternalTransportReference,
  ExternalTransportProfile,
  LoginProgress,
  OAuthPrivateState,
  OAuthSecret,
  ProviderId,
  ProviderIdentity,
  QuotaSnapshot,
} from "../core/providers";

import { randomUUID } from "node:crypto";

import { classifyAccountRefreshFailures } from "../core/account-refresh-health";
import { llmGatewayPrisma } from "../core/db";
import { GatewayError } from "../core/errors";
import { getProviderAdapter, ProviderProtocolError } from "../core/providers";
import {
  fromDbProvider,
  toDbProvider,
  type DbProvider,
} from "../core/providers/provider-id";
import {
  decryptEnvelope,
  encryptEnvelope,
  envelopeFromRecord,
  getGatewayKeyWrapper,
} from "../core/security/envelope";
import { createLeaseGuard, tryAcquireLease } from "../core/leases";
import Logger from "../config/logger";
import { getEnv } from "../config/env";

import { assertAccountRemovalKeepsTrafficSharesFeasible } from "./routing.service";

const OAUTH_TTL_MS = 15 * 60 * 1000;
const REFRESH_LEASE_MS = 60_000;
const REFRESH_HEARTBEAT_MS = 15_000;
const OAUTH_CONTINUE_TIMEOUT_MS = 2 * 60_000;
const ACCOUNT_REFRESH_TIMEOUT_MS = 5 * 60_000;

const storedModelCapabilities = (
  model: DiscoveredModel,
): Prisma.InputJsonObject => ({
  inputModalities: model.inputModalities,
  reasoning: model.reasoning,
  ...(model.reasoningEfforts
    ? { reasoningEfforts: model.reasoningEfforts }
    : {}),
  ...(model.thinkingModes ? { thinkingModes: model.thinkingModes } : {}),
  ...(model.contextManagement
    ? { contextManagement: model.contextManagement }
    : {}),
});

export interface StoredOAuthAttemptPayload {
  privateState: OAuthPrivateState;
  /** Present for reauthorization; completion must resolve to this identity. */
  targetAccountId?: string;
  authorizationUrl?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
}

export interface OAuthAttemptRow {
  id: string;
  provider: DbProvider;
  flow: "AUTHORIZATION_CODE" | "DEVICE_CODE";
  status: "PENDING" | "AUTHORIZED" | "FAILED" | "EXPIRED" | "CONSUMED";
  authorizationUrl?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  pollingIntervalSeconds?: number;
  expiresAt: string;
  failureCode?: string;
  account?: GatewayProviderAccountRow;
}

export interface GatewayProviderAccountRow {
  id: string;
  provider: DbProvider;
  email: string | null;
  displayName: string | null;
  workspaceName: string | null;
  planType: string | null;
  transportMode: "direct" | "agent-sdk";
  transportProfileId: string | null;
  enabled: boolean;
  status: "ACTIVE" | "REAUTH_REQUIRED" | "ERROR";
  healthReason: string | null;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  cooldownUntil: string | null;
  lastAuthenticatedAt: string | null;
  lastSuccessfulRequestAt: string | null;
  lastQuotaRefreshAt: string | null;
  availableModelCount: number;
  accessVerificationSupported: boolean;
  quotaWindows: Array<{
    key: string;
    label: string;
    utilizationBps: number | null;
    used: number | null;
    remaining: number | null;
    limit: number | null;
    resetAt: string | null;
    estimated: boolean;
    observedAt: string;
  }>;
  createdAt: string;
}

const accountInclude = {
  accountModels: { where: { available: true }, select: { modelId: true } },
  quotaSnapshots: { orderBy: { observedAt: "desc" as const } },
} as const;

type AccountRecord = Awaited<
  ReturnType<typeof llmGatewayPrisma.gatewayProviderAccount.findFirstOrThrow>
> & {
  accountModels?: Array<{ modelId: string }>;
  quotaSnapshots?: Array<{
    meterKey: string;
    windowKey: string;
    utilizationBps: number | null;
    remaining: number | null;
    limit: number | null;
    resetAt: Date | null;
    observedAt: Date;
  }>;
};

const toAccountRow = (account: AccountRecord): GatewayProviderAccountRow => {
  // Keep only the newest observation per meter/window in list responses.
  const quota = new Map<
    string,
    NonNullable<AccountRecord["quotaSnapshots"]>[number]
  >();

  for (const item of account.quotaSnapshots ?? []) {
    const key = `${item.meterKey}:${item.windowKey}`;
    const current = quota.get(key);

    if (
      !current ||
      item.observedAt > current.observedAt ||
      (item.observedAt.getTime() === current.observedAt.getTime() &&
        (item.utilizationBps ?? -1) > (current.utilizationBps ?? -1))
    ) {
      quota.set(key, item);
    }
  }

  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName,
    workspaceName: account.workspaceName,
    planType: account.planType,
    transportMode: account.transportMode as "direct" | "agent-sdk",
    transportProfileId: account.transportProfileId,
    enabled: account.enabled,
    status: account.status,
    healthReason: account.healthReason,
    maxConcurrency: account.maxConcurrency,
    dailyRequestCap: account.dailyRequestCap,
    dailyInputTokenCap: account.dailyInputTokenCap?.toString() ?? null,
    dailyOutputTokenCap: account.dailyOutputTokenCap?.toString() ?? null,
    cooldownUntil: account.cooldownUntil?.toISOString() ?? null,
    lastAuthenticatedAt: account.lastAuthenticatedAt?.toISOString() ?? null,
    lastSuccessfulRequestAt:
      account.lastSuccessfulRequestAt?.toISOString() ?? null,
    lastQuotaRefreshAt: account.lastQuotaRefreshAt?.toISOString() ?? null,
    availableModelCount: account.accountModels?.length ?? 0,
    accessVerificationSupported: Boolean(
      getProviderAdapter(fromDbProvider(account.provider)).verifyAccess,
    ),
    quotaWindows: [...quota.values()].map((item) => ({
      key: `${item.meterKey}:${item.windowKey}`,
      label: `${item.meterKey} · ${item.windowKey}`.replaceAll("_", " "),
      utilizationBps: item.utilizationBps,
      used: item.utilizationBps === null ? null : item.utilizationBps / 10_000,
      remaining: item.remaining,
      limit: item.limit,
      resetAt: item.resetAt?.toISOString() ?? null,
      estimated: false,
      observedAt: item.observedAt.toISOString(),
    })),
    createdAt: account.createdAt.toISOString(),
  };
};

export const listGatewayAccounts = async (): Promise<
  GatewayProviderAccountRow[]
> => {
  const accounts = await llmGatewayPrisma.gatewayProviderAccount.findMany({
    include: accountInclude,
    orderBy: [{ provider: "asc" }, { createdAt: "desc" }],
  });

  return accounts.map((account) => toAccountRow(account as AccountRecord));
};

const externalTransportAdapter = (
  provider: ProviderId,
  transportId: string,
) => {
  const adapter = getProviderAdapter(provider);

  if (transportId !== "agent-sdk" || !adapter.listExternalProfiles) {
    throw new GatewayError(
      "Provider external transport is unsupported",
      400,
      "TRANSPORT_UNSUPPORTED",
    );
  }

  return adapter;
};

export const listGatewayExternalProfiles = async (
  provider: ProviderId,
  transportId: string,
  signal?: AbortSignal,
): Promise<ExternalTransportProfile[]> => {
  const adapter = externalTransportAdapter(provider, transportId);

  return adapter.listExternalProfiles!(transportId, signal);
};

export const linkGatewayExternalProfile = async (
  actor: ActorReference,
  input: {
    provider: ProviderId;
    transportId: "agent-sdk";
    profileId: string;
    accountId?: string;
  },
  signal?: AbortSignal,
): Promise<GatewayProviderAccountRow> => {
  const profiles = await listGatewayExternalProfiles(
    input.provider,
    input.transportId,
    signal,
  );
  const profile = profiles.find(({ id }) => id === input.profileId);

  if (!profile) {
    throw new GatewayError(
      "External transport profile was not found",
      404,
      "TRANSPORT_PROFILE_NOT_FOUND",
    );
  }
  if (!profile.authenticated) {
    throw new GatewayError(
      "External transport profile requires sign-in",
      409,
      "TRANSPORT_PROFILE_REAUTH_REQUIRED",
    );
  }
  let accountId = input.accountId;

  if (accountId) {
    const existing = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
      where: { id: accountId },
      select: { provider: true },
    });

    if (!existing)
      throw new GatewayError("Account not found", 404, "NOT_FOUND");
    if (fromDbProvider(existing.provider) !== input.provider) {
      throw new GatewayError(
        "External profile provider does not match the account",
        400,
        "TRANSPORT_PROVIDER_MISMATCH",
      );
    }
    await updateGatewayAccount(accountId, {
      transportMode: "agent-sdk",
      transportProfileId: profile.id,
    });
  } else {
    const identityKey = `external:${input.transportId}:${profile.id}`;
    const dbProvider = toDbProvider(input.provider);
    const linked = await llmGatewayPrisma.gatewayProviderAccount.upsert({
      where: { provider_identityKey: { provider: dbProvider, identityKey } },
      create: {
        provider: dbProvider,
        identityKey,
        externalAccountId: identityKey,
        email: profile.email,
        displayName: profile.displayName ?? profile.email ?? profile.id,
        planType: profile.plan,
        transportMode: "agent-sdk",
        transportProfileId: profile.id,
        status: "ACTIVE",
        lastAuthenticatedAt: new Date(),
        createdByActorId: actor.id,
      },
      update: {
        email: profile.email,
        displayName: profile.displayName ?? profile.email ?? profile.id,
        planType: profile.plan,
        transportMode: "agent-sdk",
        transportProfileId: profile.id,
        status: "ACTIVE",
        healthReason: null,
        lastAuthenticatedAt: new Date(),
      },
      select: { id: true },
    });

    accountId = linked.id;
  }

  return refreshGatewayAccount(accountId, { signal });
};

const attemptPayload = async (attempt: {
  id: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyWrapperId: string;
  encryptionAlgorithm: string;
  envelopeVersion: number;
}): Promise<StoredOAuthAttemptPayload> =>
  decryptEnvelope<StoredOAuthAttemptPayload>(
    envelopeFromRecord(attempt),
    `oauth:${attempt.id}`,
    getGatewayKeyWrapper(),
  );

const toAttemptRow = async (
  attempt: {
    id: string;
    provider: DbProvider;
    flow: "AUTHORIZATION_CODE" | "DEVICE_CODE";
    status: OAuthAttemptRow["status"];
    verificationUri: string | null;
    pollingIntervalSeconds: number | null;
    expiresAt: Date;
    failureCode: string | null;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    authTag: Uint8Array;
    wrappedDataKey: Uint8Array;
    keyWrapperId: string;
    encryptionAlgorithm: string;
    envelopeVersion: number;
  },
  account?: GatewayProviderAccountRow,
): Promise<OAuthAttemptRow> => {
  let payload: StoredOAuthAttemptPayload | null = null;

  if (attempt.status === "PENDING") {
    payload = await attemptPayload(attempt);
  }

  return {
    id: attempt.id,
    provider: attempt.provider,
    flow: attempt.flow,
    status: attempt.status,
    ...(payload?.authorizationUrl && {
      authorizationUrl: payload.authorizationUrl,
    }),
    ...((payload?.verificationUri ?? attempt.verificationUri) && {
      verificationUri:
        payload?.verificationUri ?? attempt.verificationUri ?? undefined,
    }),
    ...(payload?.verificationUriComplete && {
      verificationUriComplete: payload.verificationUriComplete,
    }),
    ...(payload?.userCode && { userCode: payload.userCode }),
    ...(attempt.pollingIntervalSeconds && {
      pollingIntervalSeconds: attempt.pollingIntervalSeconds,
    }),
    expiresAt: attempt.expiresAt.toISOString(),
    ...(attempt.failureCode && { failureCode: attempt.failureCode }),
    ...(account && { account }),
  };
};

export const startOAuthAttempt = async (
  actor: ActorReference,
  provider: ProviderId,
  targetAccountId?: string,
): Promise<OAuthAttemptRow> => {
  if (targetAccountId) {
    const target = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
      where: { id: targetAccountId },
      select: { provider: true },
    });

    if (!target) throw new GatewayError("Account not found", 404, "NOT_FOUND");
    if (target.provider !== toDbProvider(provider)) {
      throw new GatewayError(
        "Reauthorization provider does not match the account",
        400,
        "PROVIDER_MISMATCH",
      );
    }
  }
  const adapter = getProviderAdapter(provider);
  const start = await adapter.startLogin();
  const id = randomUUID();
  const expiresAt = new Date(
    Math.min(start.expiresAt, Date.now() + OAUTH_TTL_MS),
  );
  const payload: StoredOAuthAttemptPayload = {
    privateState: start.privateState,
    ...(targetAccountId && { targetAccountId }),
    ...(start.kind === "paste-code"
      ? { authorizationUrl: start.authorizationUrl }
      : {
          verificationUri: start.verificationUrl,
          verificationUriComplete: start.verificationUrl,
          userCode: start.userCode,
        }),
  };
  const encrypted = await encryptEnvelope(
    payload,
    `oauth:${id}`,
    getGatewayKeyWrapper(),
  );
  const created = await llmGatewayPrisma.gatewayOAuthAttempt.create({
    data: {
      id,
      provider: toDbProvider(provider),
      flow: start.kind === "paste-code" ? "AUTHORIZATION_CODE" : "DEVICE_CODE",
      stateHash:
        typeof start.privateState.state === "string"
          ? (await import("../core/security/secrets")).sha256Hex(
              start.privateState.state,
            )
          : null,
      verificationUri:
        start.kind === "device-code" ? start.verificationUrl : null,
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
      keyWrapperId: encrypted.keyWrapperId,
      encryptionAlgorithm: encrypted.encryptionAlgorithm,
      envelopeVersion: encrypted.envelopeVersion,
      createdByActorId: actor.id,
      pollingIntervalSeconds:
        start.kind === "device-code"
          ? Math.ceil(start.intervalMs / 1_000)
          : null,
      nextPollAt:
        start.kind === "device-code"
          ? new Date(Date.now() + start.intervalMs)
          : null,
      expiresAt,
    },
  });

  return toAttemptRow(created);
};

const identityKey = (identity: ProviderIdentity): string =>
  `${identity.externalAccountId}:${identity.externalWorkspaceId ?? identity.externalAccountId}`;

export interface StoredCredentialPayload {
  secret: OAuthSecret;
  identity: ProviderIdentity;
}

interface QuotaScopeModel {
  id: string;
  upstreamModelId: string;
  publicModelId: string;
}

interface QuotaSnapshotRow {
  accountId: string;
  modelId: string | null;
  meterKey: string;
  windowKey: string;
  used: number | undefined;
  remaining: number | undefined;
  limit: number | null;
  utilizationBps: number | null;
  resetAt: Date | null;
  source: "POLL";
  observedAt: Date;
}

interface QuotaSnapshotStore {
  findModels(input: {
    provider: DbProvider;
    scopes: string[];
  }): Promise<QuotaScopeModel[]>;
  replacePollSnapshot(
    accountId: string,
    data: QuotaSnapshotRow[],
  ): Promise<void>;
}

const quotaSnapshotStore: QuotaSnapshotStore = {
  findModels: ({ provider, scopes }) =>
    llmGatewayPrisma.gatewayModel.findMany({
      where: {
        provider,
        OR: [
          { upstreamModelId: { in: scopes } },
          { publicModelId: { in: scopes } },
        ],
      },
      select: { id: true, upstreamModelId: true, publicModelId: true },
    }),
  replacePollSnapshot: async (accountId, data) => {
    await llmGatewayPrisma.$transaction(async (tx) => {
      // A provider poll is one complete generation. Rows omitted by a later
      // response must not linger and make the whole account stale forever;
      // an empty response deliberately leaves quota unknown/fail-closed.
      await tx.gatewayQuotaSnapshot.deleteMany({
        where: { accountId, source: "POLL" },
      });
      if (data.length > 0) {
        await tx.gatewayQuotaSnapshot.createMany({ data });
      }
    });
  },
};

export const saveQuotaSnapshot = async (
  accountId: string,
  snapshot: QuotaSnapshot,
  store: QuotaSnapshotStore = quotaSnapshotStore,
): Promise<void> => {
  const scopes = [
    ...new Set(
      snapshot.windows.flatMap((window) =>
        window.scope ? [window.scope] : [],
      ),
    ),
  ];
  const models =
    scopes.length === 0
      ? []
      : await store.findModels({
          provider: toDbProvider(snapshot.provider),
          scopes,
        });
  const modelIdByScope = new Map<string, string>();

  for (const model of models) {
    modelIdByScope.set(model.upstreamModelId, model.id);
    modelIdByScope.set(model.publicModelId, model.id);
  }

  await store.replacePollSnapshot(
    accountId,
    snapshot.windows.flatMap((window) => {
      const resolvedModelId = window.scope
        ? modelIdByScope.get(window.scope)
        : undefined;

      // A named scope is not provider-global merely because no matching model
      // is known. Storing it as null would block every model on the account.
      if (window.scope && !resolvedModelId) return [];

      return [
        {
          accountId,
          modelId: resolvedModelId ?? null,
          meterKey: window.meterKey ?? window.scope ?? "chat",
          windowKey: window.id,
          used: window.usedFraction,
          remaining: window.remainingFraction,
          // Fractional utilization has no absolute token unit. Treating 1 as
          // an absolute limit makes quota-balanced routing subtract the whole
          // prompt from every account's fractional headroom.
          limit: null,
          utilizationBps:
            window.allowed === false || window.limitReached === true
              ? 10_000
              : window.usedFraction === undefined
                ? null
                : Math.round(
                    Math.max(0, Math.min(1, window.usedFraction)) * 10_000,
                  ),
          resetAt: window.resetsAt ? new Date(window.resetsAt) : null,
          source: "POLL" as const,
          observedAt: new Date(snapshot.fetchedAt),
        },
      ];
    }),
  );
};

const discoverAccountModels = async (
  accountId: string,
  provider: ProviderId,
  secret: OAuthSecret | null,
  signal?: AbortSignal,
  transport?: ExternalTransportReference,
): Promise<void> => {
  const adapter = getProviderAdapter(provider);
  const discovery = transport
    ? await adapter.discoverExternal?.(transport, signal)
    : secret
      ? await adapter.discover(secret, signal)
      : undefined;

  if (!discovery) {
    throw new ProviderProtocolError(
      "Provider does not support the configured discovery transport",
      503,
    );
  }
  const { models } = discovery;

  signal?.throwIfAborted();
  const dbProvider = toDbProvider(provider);
  let defaultPool = await llmGatewayPrisma.gatewayRoutingPool.findFirst({
    where: { provider: dbProvider, name: "Default" },
  });

  if (!defaultPool) {
    defaultPool = await llmGatewayPrisma.gatewayRoutingPool.create({
      data: { provider: dbProvider, name: "Default", policy: "QUOTA_BALANCED" },
    });
  }
  // Enrollment creates a default membership once. Subsequent discovery must
  // never re-enable or recreate a membership an operator disabled/deleted.
  const [existingMembershipCount, existingAccountModelCount] =
    await Promise.all([
      llmGatewayPrisma.gatewayRoutingPoolMember.count({
        where: { accountId },
      }),
      llmGatewayPrisma.gatewayAccountModel.count({ where: { accountId } }),
    ]);

  if (existingMembershipCount === 0 && existingAccountModelCount === 0) {
    await llmGatewayPrisma.gatewayRoutingPoolMember.create({
      data: { routingPoolId: defaultPool.id, accountId },
    });
  }

  const seenIds: string[] = [];

  for (const model of models) {
    signal?.throwIfAborted();
    const publicModelId = `${provider}/${model.upstreamId}`;
    const stored = await llmGatewayPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-model-name:${publicModelId}`}, 0)
        )
      `;
      // Canonical discovery owns its namespace. Disable a legacy/future alias
      // collision before publishing the canonical ID.
      await tx.gatewayModelAlias.updateMany({
        where: { alias: publicModelId },
        data: { enabled: false },
      });
      const storedModel = await tx.gatewayModel.upsert({
        where: {
          provider_upstreamModelId: {
            provider: dbProvider,
            upstreamModelId: model.upstreamId,
          },
        },
        create: {
          provider: dbProvider,
          upstreamModelId: model.upstreamId,
          publicModelId,
          displayName: model.name,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: storedModelCapabilities(model),
          catalogSource: model.source,
          catalogVersion: model.etag,
          routingPoolId: defaultPool.id,
          staleAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        update: {
          displayName: model.name,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: storedModelCapabilities(model),
          catalogSource: model.source,
          catalogVersion: model.etag,
          lastSeenAt: new Date(),
          staleAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      await tx.gatewayAccountModel.upsert({
        where: {
          accountId_modelId: { accountId, modelId: storedModel.id },
        },
        create: { accountId, modelId: storedModel.id },
        update: {
          available: true,
          unavailableReason: null,
          lastSeenAt: new Date(),
        },
      });

      return storedModel;
    });

    seenIds.push(stored.id);
  }

  if (seenIds.length > 0) {
    await llmGatewayPrisma.gatewayAccountModel.updateMany({
      where: { accountId, modelId: { notIn: seenIds } },
      data: {
        available: false,
        unavailableReason: "Not present in latest catalog",
      },
    });
  }
  await llmGatewayPrisma.gatewayProviderAccount.update({
    where: { id: accountId },
    data: {
      lastModelCatalogRefreshAt: new Date(),
      ...(discovery.nativeCatalog
        ? {
            nativeModelCatalog: discovery.nativeCatalog
              .entries as Prisma.InputJsonArray,
            nativeModelCatalogEtag: discovery.nativeCatalog.etag ?? null,
          }
        : {}),
    },
  });
};

const finishLogin = async (
  attemptId: string,
  provider: ProviderId,
  progress: Extract<LoginProgress, { kind: "complete" }>,
  targetAccountId?: string,
  signal?: AbortSignal,
): Promise<OAuthAttemptRow> => {
  signal?.throwIfAborted();
  const oauthAttempt =
    await llmGatewayPrisma.gatewayOAuthAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { createdByActorId: true },
    });
  const dbProvider = toDbProvider(provider);
  const adapter = getProviderAdapter(provider);
  const key = identityKey(progress.identity);
  const target = targetAccountId
    ? await llmGatewayPrisma.gatewayProviderAccount.findUnique({
        where: { id: targetAccountId },
      })
    : null;

  if (targetAccountId && !target) {
    throw new GatewayError(
      "Reauthorization account not found",
      404,
      "NOT_FOUND",
    );
  }
  if (
    target &&
    (target.provider !== dbProvider || target.identityKey !== key)
  ) {
    throw new GatewayError(
      "Signed-in identity does not match the account being reauthorized",
      409,
      "REAUTH_IDENTITY_MISMATCH",
    );
  }
  const account = target
    ? await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: target.id },
        data: {
          email: progress.identity.email,
          workspaceName: progress.identity.displayName,
          planType: progress.identity.plan,
          enabled: true,
          status: "ACTIVE",
          healthReason: null,
          lastAuthenticatedAt: new Date(),
        },
      })
    : await llmGatewayPrisma.gatewayProviderAccount.upsert({
        where: {
          provider_identityKey: { provider: dbProvider, identityKey: key },
        },
        create: {
          provider: dbProvider,
          identityKey: key,
          externalAccountId: progress.identity.externalAccountId,
          externalWorkspaceId: progress.identity.externalWorkspaceId,
          email: progress.identity.email,
          displayName: progress.identity.displayName ?? progress.identity.email,
          workspaceName: progress.identity.displayName,
          planType: progress.identity.plan,
          status: "ACTIVE",
          lastAuthenticatedAt: new Date(),
          createdByActorId: oauthAttempt.createdByActorId,
        },
        update: {
          externalAccountId: progress.identity.externalAccountId,
          externalWorkspaceId: progress.identity.externalWorkspaceId,
          email: progress.identity.email,
          workspaceName: progress.identity.displayName,
          planType: progress.identity.plan,
          enabled: true,
          status: "ACTIVE",
          healthReason: null,
          lastAuthenticatedAt: new Date(),
        },
      });
  const encrypted = await encryptEnvelope(
    {
      secret: progress.secret,
      identity: progress.identity,
    } satisfies StoredCredentialPayload,
    `credential:${account.id}`,
    getGatewayKeyWrapper(),
  );

  signal?.throwIfAborted();

  await llmGatewayPrisma.$transaction([
    llmGatewayPrisma.gatewayProviderCredential.upsert({
      where: { accountId: account.id },
      create: {
        accountId: account.id,
        ciphertext: Buffer.from(encrypted.ciphertext),
        nonce: Buffer.from(encrypted.nonce),
        authTag: Buffer.from(encrypted.authTag),
        wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
        keyWrapperId: encrypted.keyWrapperId,
        encryptionAlgorithm: encrypted.encryptionAlgorithm,
        envelopeVersion: encrypted.envelopeVersion,
        accessTokenExpiresAt: new Date(progress.secret.expiresAt),
      },
      update: {
        ciphertext: Buffer.from(encrypted.ciphertext),
        nonce: Buffer.from(encrypted.nonce),
        authTag: Buffer.from(encrypted.authTag),
        wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
        keyWrapperId: encrypted.keyWrapperId,
        encryptionAlgorithm: encrypted.encryptionAlgorithm,
        envelopeVersion: encrypted.envelopeVersion,
        accessTokenExpiresAt: new Date(progress.secret.expiresAt),
        revision: { increment: 1 },
      },
    }),
    llmGatewayPrisma.gatewayOAuthAttempt.update({
      where: { id: attemptId },
      data: { status: "AUTHORIZED", consumedAt: new Date() },
    }),
  ]);

  signal?.throwIfAborted();

  const [modelsResult, quotaResult] = await Promise.allSettled([
    discoverAccountModels(account.id, provider, progress.secret, signal),
    adapter.fetchQuota(progress.secret, progress.identity, signal),
  ]);

  signal?.throwIfAborted();
  const backgroundErrors: unknown[] = [];

  if (modelsResult.status === "rejected") {
    backgroundErrors.push(modelsResult.reason);
  }

  if (quotaResult.status === "fulfilled") {
    try {
      // Discovery has settled, so a first-login model-scoped quota can resolve
      // the GatewayModel row created during this same post-login refresh.
      await saveQuotaSnapshot(account.id, quotaResult.value);
      await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: account.id },
        data: { lastQuotaRefreshAt: new Date(quotaResult.value.fetchedAt) },
      });
    } catch (error) {
      backgroundErrors.push(error);
    }
  } else {
    backgroundErrors.push(quotaResult.reason);
  }

  for (const error of backgroundErrors) {
    Logger.warn("Gateway account post-login refresh failed", {
      accountId: account.id,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const full = await llmGatewayPrisma.gatewayProviderAccount.findUniqueOrThrow({
    where: { id: account.id },
    include: accountInclude,
  });
  const attempt = await llmGatewayPrisma.gatewayOAuthAttempt.findUniqueOrThrow({
    where: { id: attemptId },
  });

  return toAttemptRow(attempt, toAccountRow(full as AccountRecord));
};

const loadAttempt = async (attemptId: string, mutateExpired = true) => {
  const attempt = await llmGatewayPrisma.gatewayOAuthAttempt.findUnique({
    where: { id: attemptId },
  });

  if (!attempt)
    throw new GatewayError("OAuth attempt not found", 404, "NOT_FOUND");
  if (attempt.expiresAt <= new Date() && attempt.status === "PENDING") {
    if (!mutateExpired) {
      return {
        ...attempt,
        status: "EXPIRED" as const,
        failureCode: "OAUTH_EXPIRED",
      };
    }

    return llmGatewayPrisma.gatewayOAuthAttempt.update({
      where: { id: attempt.id },
      data: { status: "EXPIRED", failureCode: "OAUTH_EXPIRED" },
    });
  }

  return attempt;
};

const continueAttemptUnlocked = async (
  attemptId: string,
  pastedInput?: string,
  signal?: AbortSignal,
): Promise<OAuthAttemptRow> => {
  signal?.throwIfAborted();
  const attempt = await loadAttempt(attemptId);

  if (attempt.status !== "PENDING") return toAttemptRow(attempt);
  if (
    attempt.flow === "DEVICE_CODE" &&
    !pastedInput &&
    attempt.nextPollAt &&
    attempt.nextPollAt > new Date()
  ) {
    return toAttemptRow(attempt);
  }

  const payload = await attemptPayload(attempt);
  const provider = fromDbProvider(attempt.provider);
  const progress = await getProviderAdapter(provider).continueLogin(
    payload.privateState,
    pastedInput,
    signal,
  );

  signal?.throwIfAborted();

  if (progress.kind === "complete") {
    return finishLogin(
      attempt.id,
      provider,
      progress,
      payload.targetAccountId,
      signal,
    );
  }
  if (progress.kind === "denied" || progress.kind === "expired") {
    const updated = await llmGatewayPrisma.gatewayOAuthAttempt.update({
      where: { id: attempt.id },
      data: {
        status: progress.kind === "expired" ? "EXPIRED" : "FAILED",
        failureCode:
          progress.kind === "expired" ? "OAUTH_EXPIRED" : "OAUTH_DENIED",
      },
    });

    return toAttemptRow(updated);
  }

  const nextPayload = {
    ...payload,
    privateState: progress.privateState ?? payload.privateState,
  };
  const encrypted = await encryptEnvelope(
    nextPayload,
    `oauth:${attempt.id}`,
    getGatewayKeyWrapper(),
  );

  signal?.throwIfAborted();
  const updated = await llmGatewayPrisma.gatewayOAuthAttempt.update({
    where: { id: attempt.id },
    data: {
      ciphertext: Buffer.from(encrypted.ciphertext),
      nonce: Buffer.from(encrypted.nonce),
      authTag: Buffer.from(encrypted.authTag),
      wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
      keyWrapperId: encrypted.keyWrapperId,
      encryptionAlgorithm: encrypted.encryptionAlgorithm,
      envelopeVersion: encrypted.envelopeVersion,
      nextPollAt: new Date(progress.nextPollAt),
    },
  });

  return toAttemptRow(updated);
};

const continueAttempt = async (
  attemptId: string,
  pastedInput?: string,
): Promise<OAuthAttemptRow> => {
  const lease = await tryAcquireLease({
    kind: "TOKEN_REFRESH",
    resourceId: `oauth:${attemptId}`,
    ttlMs: REFRESH_LEASE_MS,
  });

  if (!lease) {
    throw new GatewayError(
      "OAuth attempt is already being processed",
      409,
      "OAUTH_ATTEMPT_IN_PROGRESS",
    );
  }
  const guard = createLeaseGuard({
    leases: [lease],
    ttlMs: REFRESH_LEASE_MS,
    heartbeatIntervalMs: REFRESH_HEARTBEAT_MS,
    timeoutMs: OAUTH_CONTINUE_TIMEOUT_MS,
  });

  try {
    return await continueAttemptUnlocked(attemptId, pastedInput, guard.signal);
  } finally {
    await guard.finish();
  }
};

export const getOAuthAttempt = async (
  attemptId: string,
): Promise<OAuthAttemptRow> =>
  toAttemptRow(await loadAttempt(attemptId, false));

export const pollOAuthAttempt = async (
  attemptId: string,
): Promise<OAuthAttemptRow> => {
  const attempt = await loadAttempt(attemptId);

  if (attempt.flow !== "DEVICE_CODE") {
    throw new GatewayError(
      "Only device-code attempts can be polled",
      400,
      "OAUTH_FLOW_MISMATCH",
    );
  }

  return continueAttempt(attemptId);
};

export const completeOAuthAttempt = (
  attemptId: string,
  authorizationInput: string,
): Promise<OAuthAttemptRow> => continueAttempt(attemptId, authorizationInput);

export interface UpdateGatewayAccountInput {
  enabled?: boolean;
  displayName?: string | null;
  maxConcurrency?: number | null;
  dailyRequestCap?: number | null;
  dailyInputTokenCap?: bigint | null;
  dailyOutputTokenCap?: bigint | null;
  transportMode?: "direct" | "agent-sdk";
  transportProfileId?: string | null;
}

export const updateGatewayAccount = async (
  id: string,
  input: UpdateGatewayAccountInput,
): Promise<GatewayProviderAccountRow> => {
  const existing = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
    where: { id },
  });

  if (!existing) throw new GatewayError("Account not found", 404, "NOT_FOUND");
  let transportProfileId = input.transportProfileId;

  if (
    input.transportMode !== undefined ||
    input.transportProfileId !== undefined
  ) {
    const transportMode = input.transportMode ?? existing.transportMode;

    transportProfileId =
      transportMode === "direct"
        ? null
        : (input.transportProfileId ?? existing.transportProfileId);
    if (
      transportMode === "direct" &&
      existing.transportMode !== "direct" &&
      !(await llmGatewayPrisma.gatewayProviderCredential.findUnique({
        where: { accountId: existing.id },
        select: { id: true },
      }))
    ) {
      throw new GatewayError(
        "This account has no direct provider credential",
        409,
        "DIRECT_CREDENTIAL_REQUIRED",
      );
    }
    if (transportMode === "agent-sdk") {
      const provider = fromDbProvider(existing.provider);
      const adapter = getProviderAdapter(provider);
      const env = getEnv();

      if (
        provider !== "anthropic" ||
        !adapter.prepareExternalInference ||
        !adapter.prepareExternalResponsesInference
      ) {
        throw new GatewayError(
          "This provider does not support the Agent SDK transport",
          400,
          "TRANSPORT_UNSUPPORTED",
        );
      }
      if (
        !env.GATEWAY_ANTHROPIC_AGENT_SDK_URL ||
        !env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY
      ) {
        throw new GatewayError(
          "The Anthropic Agent SDK transport is not configured",
          503,
          "TRANSPORT_UNAVAILABLE",
        );
      }
      if (!transportProfileId) {
        throw new GatewayError(
          "An Agent SDK profile is required",
          400,
          "TRANSPORT_PROFILE_REQUIRED",
        );
      }
    }
  }
  const account = await llmGatewayPrisma.$transaction(
    async (tx) => {
      if (existing.enabled && input.enabled === false) {
        await assertAccountRemovalKeepsTrafficSharesFeasible(id, tx);
      }

      return tx.gatewayProviderAccount.update({
        where: { id },
        data: {
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.displayName !== undefined && {
            displayName: input.displayName || null,
          }),
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
          ...(input.transportMode !== undefined && {
            transportMode: input.transportMode,
          }),
          ...((input.transportMode !== undefined ||
            input.transportProfileId !== undefined) && {
            transportProfileId,
          }),
        },
        include: accountInclude,
      });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return toAccountRow(account as AccountRecord);
};

export const loadCredential = async (
  accountId: string,
): Promise<{
  secret: OAuthSecret;
  identity: ProviderIdentity;
  revision: number;
}> => {
  const credential =
    await llmGatewayPrisma.gatewayProviderCredential.findUnique({
      where: { accountId },
    });

  if (!credential)
    throw new GatewayError(
      "Account requires sign-in",
      503,
      "ACCOUNT_REAUTH_REQUIRED",
    );
  const payload = await decryptEnvelope<StoredCredentialPayload>(
    envelopeFromRecord(credential),
    `credential:${accountId}`,
    getGatewayKeyWrapper(),
  );

  return { ...payload, revision: credential.revision };
};

export interface GatewayAccountAccessVerification {
  status: "ready" | "action_required";
  actionUrl?: string;
}

export const verifyGatewayAccountAccess = async (
  accountId: string,
  signal?: AbortSignal,
): Promise<GatewayAccountAccessVerification> => {
  const lease = await tryAcquireLease({
    kind: "TOKEN_REFRESH",
    resourceId: `verify:${accountId}`,
    ttlMs: REFRESH_LEASE_MS,
  });

  if (!lease)
    throw new GatewayError(
      "Account verification is already running",
      409,
      "VERIFICATION_IN_PROGRESS",
    );
  const guard = createLeaseGuard({
    leases: [lease],
    ttlMs: REFRESH_LEASE_MS,
    heartbeatIntervalMs: REFRESH_HEARTBEAT_MS,
    signal,
    timeoutMs: ACCOUNT_REFRESH_TIMEOUT_MS,
  });

  try {
    const account = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
      where: { id: accountId },
      select: { provider: true, transportMode: true },
    });

    if (!account) throw new GatewayError("Account not found", 404, "NOT_FOUND");
    if (account.transportMode !== "direct") {
      throw new GatewayError(
        "External transports own their account verification",
        400,
        "VERIFICATION_UNSUPPORTED",
      );
    }
    const adapter = getProviderAdapter(fromDbProvider(account.provider));

    if (!adapter.verifyAccess) {
      throw new GatewayError(
        "Provider does not expose an account verification flow",
        400,
        "VERIFICATION_UNSUPPORTED",
      );
    }
    let credential = await loadCredential(accountId);

    if (credential.secret.expiresAt <= Date.now() + 5 * 60 * 1000) {
      await refreshGatewayAccount(accountId, {
        refreshCredential: true,
        signal: guard.signal,
      });
      credential = await loadCredential(accountId);
    }
    guard.throwIfFailed();
    const result = await adapter.verifyAccess(
      credential.secret,
      credential.identity,
      guard.signal,
    );

    guard.throwIfFailed();
    if (result.kind === "ready") {
      await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: accountId },
        data: { status: "ACTIVE", healthReason: null },
      });

      return { status: "ready" };
    }
    await llmGatewayPrisma.gatewayProviderAccount.update({
      where: { id: accountId },
      data: {
        status: "ERROR",
        healthReason: "Provider account verification required",
      },
    });

    return { status: "action_required", actionUrl: result.actionUrl };
  } finally {
    await guard.finish();
  }
};

export const refreshGatewayAccount = async (
  accountId: string,
  options: { refreshCredential?: boolean; signal?: AbortSignal } = {},
): Promise<GatewayProviderAccountRow> => {
  const lease = await tryAcquireLease({
    kind: "TOKEN_REFRESH",
    resourceId: accountId,
    ttlMs: REFRESH_LEASE_MS,
  });

  if (!lease)
    throw new GatewayError(
      "Account refresh is already running",
      409,
      "REFRESH_IN_PROGRESS",
    );
  const guard = createLeaseGuard({
    leases: [lease],
    ttlMs: REFRESH_LEASE_MS,
    heartbeatIntervalMs: REFRESH_HEARTBEAT_MS,
    signal: options.signal,
    timeoutMs: ACCOUNT_REFRESH_TIMEOUT_MS,
  });

  try {
    guard.throwIfFailed();
    const account = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
      where: { id: accountId },
    });

    guard.throwIfFailed();
    if (!account) throw new GatewayError("Account not found", 404, "NOT_FOUND");
    const provider = fromDbProvider(account.provider);
    const adapter = getProviderAdapter(provider);
    const recordRefreshFailure = async (
      failures: readonly unknown[],
    ): Promise<void> => {
      guard.throwIfFailed();
      await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: account.id },
        data: classifyAccountRefreshFailures(failures),
      });
    };
    let quotaRefresh: Promise<QuotaSnapshot>;
    let modelRefresh: Promise<void>;

    if (account.transportMode === "agent-sdk") {
      if (
        !account.transportProfileId ||
        !adapter.fetchExternalQuota ||
        !adapter.discoverExternal
      ) {
        throw new GatewayError(
          "Account external transport is unavailable",
          503,
          "TRANSPORT_UNAVAILABLE",
        );
      }
      const transport = {
        id: "agent-sdk",
        profileId: account.transportProfileId,
      };

      quotaRefresh = adapter.fetchExternalQuota(transport, guard.signal);
      modelRefresh = discoverAccountModels(
        account.id,
        provider,
        null,
        guard.signal,
        transport,
      );
    } else {
      let loaded: Awaited<ReturnType<typeof loadCredential>>;

      try {
        loaded = await loadCredential(account.id);
      } catch (error) {
        if (
          error instanceof GatewayError &&
          error.code === "ACCOUNT_REAUTH_REQUIRED"
        ) {
          await recordRefreshFailure([error]);
        }
        throw error;
      }
      let secret = loaded.secret;
      let identity = loaded.identity;

      if (
        options.refreshCredential ||
        secret.expiresAt <= Date.now() + 5 * 60 * 1000
      ) {
        let refreshed: Awaited<ReturnType<typeof adapter.refresh>>;

        try {
          refreshed = await adapter.refresh(secret, guard.signal);
        } catch (error) {
          await recordRefreshFailure([error]);
          throw error;
        }

        guard.throwIfFailed();
        secret = refreshed.secret;
        identity = { ...identity, ...refreshed.identityPatch };
        const encrypted = await encryptEnvelope(
          { secret, identity } satisfies StoredCredentialPayload,
          `credential:${account.id}`,
          getGatewayKeyWrapper(),
        );

        guard.throwIfFailed();
        const updated =
          await llmGatewayPrisma.gatewayProviderCredential.updateMany({
            where: { accountId: account.id, revision: loaded.revision },
            data: {
              ciphertext: Buffer.from(encrypted.ciphertext),
              nonce: Buffer.from(encrypted.nonce),
              authTag: Buffer.from(encrypted.authTag),
              wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
              keyWrapperId: encrypted.keyWrapperId,
              encryptionAlgorithm: encrypted.encryptionAlgorithm,
              envelopeVersion: encrypted.envelopeVersion,
              accessTokenExpiresAt: new Date(secret.expiresAt),
              revision: { increment: 1 },
              lastRefreshedAt: new Date(),
            },
          });

        if (updated.count !== 1) {
          throw new GatewayError(
            "Credential changed during refresh",
            409,
            "STALE_CREDENTIAL",
          );
        }
      }

      quotaRefresh = adapter.fetchQuota(secret, identity, guard.signal);
      modelRefresh = discoverAccountModels(
        account.id,
        provider,
        secret,
        guard.signal,
      );
    }

    const [quotaResult, modelsResult] = await Promise.allSettled([
      quotaRefresh,
      modelRefresh,
    ]);

    guard.throwIfFailed();

    if (quotaResult.status === "fulfilled") {
      await saveQuotaSnapshot(account.id, quotaResult.value);
      await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: account.id },
        data: {
          lastQuotaRefreshAt: new Date(quotaResult.value.fetchedAt),
          ...(modelsResult.status === "fulfilled" && {
            status: "ACTIVE",
            healthReason: null,
          }),
        },
      });
    }
    const refreshFailures = [quotaResult, modelsResult]
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    const refreshHealth = classifyAccountRefreshFailures(refreshFailures);

    if (
      refreshHealth.status === "REAUTH_REQUIRED" ||
      refreshFailures.length === 2
    ) {
      await recordRefreshFailure(refreshFailures);
    }
    const full =
      await llmGatewayPrisma.gatewayProviderAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: accountInclude,
      });

    guard.throwIfFailed();

    return toAccountRow(full as AccountRecord);
  } finally {
    await guard.finish();
  }
};

export const deleteGatewayAccount = async (
  id: string,
): Promise<GatewayProviderAccountRow> => {
  const account = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
    where: { id },
    include: accountInclude,
  });

  if (!account) throw new GatewayError("Account not found", 404, "NOT_FOUND");
  await llmGatewayPrisma.$transaction(
    async (tx) => {
      await assertAccountRemovalKeepsTrafficSharesFeasible(id, tx);
      await tx.gatewayProviderAccount.delete({ where: { id } });
    },
    { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
  );

  return toAccountRow(account as AccountRecord);
};

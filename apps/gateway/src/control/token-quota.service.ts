import { createLeaseGuard, tryAcquireConcurrencyLease } from "../core/leases";
import { randomUUID } from "node:crypto";
import { llmGatewayPrisma } from "../core/db";
import { getProviderAdapter, ProviderProtocolError } from "../core/providers";
import { getAnthropicAgentSdkTransport } from "../core/providers/anthropic-agent-sdk";
import { parseAnthropicQuotaHeaders } from "../core/providers/anthropic";
import { persistGatewayHeaderQuota } from "../core/data-plane/routing";
import { loadCredential } from "./accounts.service";

export const GENERAL_PROBE_MS = 30 * 60_000;
export const SCOPED_PROBE_MS = 60 * 60_000;

export async function collectTokenSdkQuota(
  accountId: string,
  modelId: string,
): Promise<void> {
  const account = await llmGatewayPrisma.gatewayProviderAccount.findUnique({
    where: { id: accountId },
  });
  if (
    account?.authenticationMethod !== "oauth-token" ||
    account.transportMode !== "agent-sdk" ||
    !account.transportProfileId
  )
    return;
  const model = await llmGatewayPrisma.gatewayModel.findUniqueOrThrow({
    where: { id: modelId },
  });
  const snapshot = await getAnthropicAgentSdkTransport().tokenQuota(
    {
      id: "agent-sdk",
      profileId: account.transportProfileId,
      tokenBacked: true,
    },
    model.upstreamModelId,
  );
  await persistGatewayHeaderQuota(accountId, modelId, snapshot);
}

export async function refreshTokenAccountQuota(
  accountId: string,
  signal?: AbortSignal,
  onboarding = false,
): Promise<void> {
  const account =
    await llmGatewayPrisma.gatewayProviderAccount.findUniqueOrThrow({
      where: { id: accountId },
      include: {
        accountModels: { where: { available: true }, include: { model: true } },
        poolMemberships: {
          where: { enabled: true, routingPool: { enabled: true } },
        },
      },
    });
  if (
    account.authenticationMethod !== "oauth-token" ||
    (!onboarding &&
      (!account.enabled ||
        !account.poolMemberships.length ||
        account.status === "REAUTH_REQUIRED"))
  )
    return;
  const pools = new Set(account.poolMemberships.map((m) => m.routingPoolId));
  const models = account.accountModels
    .map((m) => m.model)
    .filter((m) => m.enabled)
    .filter(
      (m) => onboarding || (m.routingPoolId && pools.has(m.routingPoolId)),
    );
  if (!models.length) return;
  // Family metadata comes from the authenticated live catalog; never invent IDs.
  const general = [
    ...account.accountModels.map((m) => m.model).filter((m) => m.enabled),
  ].sort(
    (a, b) =>
      Number(!/haiku/i.test(a.displayName)) -
        Number(!/haiku/i.test(b.displayName)) ||
      a.upstreamModelId.localeCompare(b.upstreamModelId),
  )[0];
  const scoped = models.filter((m) => /fable/i.test(m.displayName));
  const loaded = await loadCredential(accountId);
  if (loaded.secret.kind !== "access-token")
    throw new ProviderProtocolError("Token account credential mismatch", 401);
  const adapter = getProviderAdapter("anthropic");
  for (const kind of onboarding ? ["general"] : ["general", "scoped"]) {
    const interval = kind === "general" ? GENERAL_PROBE_MS : SCOPED_PROBE_MS;
    const now = new Date();
    const model = await llmGatewayPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int FROM pg_advisory_xact_lock(hashtextextended(${`token-probe:${accountId}`}, 0))`;
      const previous = await tx.gatewayTokenProbe.findUnique({
        where: { accountId_kind: { accountId, kind } },
      });
      if (previous && now.getTime() - previous.attemptedAt.getTime() < interval)
        return null;
      const candidates = kind === "general" ? [general] : scoped;
      const observations = await tx.gatewayQuotaSnapshot.findMany({
        where: {
          accountId,
          ...(kind === "general"
            ? { modelId: null }
            : { modelId: { in: candidates.map((m) => m.id) } }),
          observedAt: { gte: new Date(now.getTime() - interval) },
        },
      });
      const eligible = candidates.filter(
        (m) =>
          !observations.some((o) =>
            kind === "general"
              ? o.windowKey === "five_hour" || o.windowKey === "seven_day"
              : o.modelId === m.id &&
                o.windowKey === "seven_day_overage_included",
          ),
      );
      if (!eligible.length) return null;
      const selected =
        eligible.find((m) => m.id !== previous?.modelId) ?? eligible[0];
      await tx.gatewayTokenProbe.upsert({
        where: { accountId_kind: { accountId, kind } },
        create: {
          accountId,
          kind,
          attemptedAt: now,
          modelId: selected.id,
        },
        update: {
          attemptedAt: now,

          modelId: selected.id,
          statusCode: null,
          inputTokens: null,
          outputTokens: null,
        },
      });
      return selected;
    });
    if (!model) continue;
    const lease = await tryAcquireConcurrencyLease({
      kind: "ACCOUNT_CONCURRENCY",
      resourceId: accountId,
      maxConcurrency: account.maxConcurrency,
      ttlMs: 45_000,
    });
    if (!lease) continue;
    const guard = createLeaseGuard({
      leases: [lease],
      ttlMs: 45_000,
      heartbeatIntervalMs: 10_000,
      timeoutMs: 30_000,
      signal,
    });
    try {
      const probeSignal = guard.signal;
      const common = {
        request: {
          model: model.upstreamModelId,
          max_tokens: 1,
          messages: [{ role: "user" as const, content: "Reply OK." }],
          stream: false,
        },
        upstreamModel: model.upstreamModelId,
        publicModel: model.publicModelId,
        identity: loaded.identity,
        secret: loaded.secret,
        sessionId: `quota-${randomUUID()}`,
        signal: probeSignal,
      };
      // Quota probes use the adapter's direct endpoint. SDK readiness is established
      // only by a successful SDK inference, never by this direct quota lookup.
      const prepared = await adapter.prepareQuotaProbe!(common);
      guard.throwIfFailed();
      await llmGatewayPrisma.gatewayTokenProbe.update({
        where: { accountId_kind: { accountId, kind } },
        data: {
          attemptCount: { increment: 1 },
          unknownUsageCount: { increment: 1 },
        },
      });
      const response = await fetch(prepared.url, {
        ...prepared.init,
        redirect: "error",
        signal: probeSignal,
      });
      await llmGatewayPrisma.gatewayTokenProbe.update({
        where: { accountId_kind: { accountId, kind } },
        data: { statusCode: response.status },
      });
      const quota = parseAnthropicQuotaHeaders(response.headers);
      if (quota) await persistGatewayHeaderQuota(accountId, model.id, quota);
      const org = response.headers.get("anthropic-organization-id");
      if (org && /^[0-9a-f-]{36}$/i.test(org))
        await llmGatewayPrisma.gatewayProviderAccount.update({
          where: { id: accountId },
          data: { externalWorkspaceId: org },
        });
      // Consume a bounded response for structural usage only. Never store content.
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (reader)
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 128 * 1024) {
              await reader.cancel();
              break;
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      if (response.ok && bytes <= 128 * 1024) {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const usage = payload?.usage;
          const count = (v: unknown) =>
            typeof v === "number" && Number.isSafeInteger(v) && v >= 0
              ? BigInt(v)
              : null;
          await llmGatewayPrisma.gatewayTokenProbe.update({
            where: { accountId_kind: { accountId, kind } },
            data: {
              inputTokens: count(usage?.input_tokens),
              outputTokens: count(usage?.output_tokens),
              ...(count(usage?.input_tokens) !== null &&
              count(usage?.output_tokens) !== null
                ? {
                    inputTokensTotal: { increment: count(usage.input_tokens)! },
                    outputTokensTotal: {
                      increment: count(usage.output_tokens)!,
                    },
                    unknownUsageCount: { decrement: 1 },
                  }
                : {}),
            },
          });
          if (
            account.transportMode === "direct" &&
            payload?.type === "message" &&
            payload?.stop_reason
          )
            await llmGatewayPrisma.gatewayProviderAccount.updateMany({
              where: { id: accountId, status: { not: "REAUTH_REQUIRED" } },
              data: {
                inferenceReadyAt: new Date(),
                status: "ACTIVE",
                healthReason: null,
              },
            });
        } catch {
          /* Missing usage is unknown, never zero. */
        }
      }

      if (response.status === 401 || response.status === 403) {
        await llmGatewayPrisma.gatewayProviderAccount.update({
          where: { id: accountId },
          data: {
            status: "REAUTH_REQUIRED",
            healthReason: "OAuth token rejected; create a new account",
          },
        });
        return;
      }
      if (response.status >= 500)
        throw new ProviderProtocolError(
          "Token probe unavailable",
          response.status,
        );
      await llmGatewayPrisma.gatewayProviderAccount.update({
        where: { id: accountId },
        data: { lastQuotaRefreshAt: new Date() },
      });
    } finally {
      await guard.finish();
    }
  }
}

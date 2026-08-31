import type { GatewayClientPrincipal } from "../../control/client-keys.service";
import type { GatewayRoutingPolicy } from "../../generated/prisma/enums";

import {
  reconcileClientUsageReservation,
  reserveClientDailyCapacity,
  reserveClientRetryCapacity,
  type GatewayClientUsageReservation,
} from "../../control/client-keys.service";
import {
  loadCredential,
  refreshGatewayAccount,
} from "../../control/accounts.service";
import {
  listRoutableGatewayModels,
  resolveGatewayModel,
} from "../../control/models.service";
import {
  reconcileAccountUsageReservation,
  type GatewayAccountUsageReservation,
} from "../account-usage";
import { llmGatewayPrisma } from "../db";
import { GatewayError } from "../errors";
import { createLeaseGuard } from "../leases";
import {
  getProviderAdapter,
  ProviderProtocolError,
  readBoundedJson,
  type ProviderFailure,
} from "../providers";
import { fromDbProvider } from "../providers/provider-id";
import { hmacGatewaySession } from "../security/secrets";
import { codexGatewayModelId } from "../wire/codex-responses";
import {
  parseCodexSearchResponse,
  type CodexSearchRequest,
} from "../wire/codex-search";
import { secureDataPlaneHeaders } from "./response-headers";
import {
  acquireClientLease,
  normalizedSessionId,
  persistGatewayHeaderQuota,
  routeAccount,
} from "./routing";

const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_INFERENCE_LIFETIME_MS = 10 * 60_000;
const MAX_SEARCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEARCH_OUTPUT_TOKENS = 4_096;
const MAX_SEARCH_DISPATCHES = 3;

const approximateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4) + 64);

const searchResponse = async (
  response: Response,
): Promise<{ response: Response; outputTokens: number }> => {
  let body;

  try {
    body = parseCodexSearchResponse(
      await readBoundedJson(response, MAX_SEARCH_RESPONSE_BYTES),
    );
  } catch {
    throw new ProviderProtocolError(
      "Provider returned an invalid web-search response",
      response.status,
    );
  }
  const headers = secureDataPlaneHeaders();
  const contentType = response.headers.get("content-type");

  headers.set(
    "content-type",
    contentType?.includes("json")
      ? contentType
      : "application/json; charset=utf-8",
  );

  return {
    response: new Response(JSON.stringify(body), {
      status: response.status,
      headers,
    }),
    outputTokens: approximateTextTokens(body.output),
  };
};

const selectSearchModel = async (
  principal: GatewayClientPrincipal,
  requestedModel: string,
) => {
  const routableOpenAIModels = (await listRoutableGatewayModels()).filter(
    (model) =>
      model.provider === "OPENAI" &&
      (principal.allowAllModels ||
        principal.allowedModelIds.has(model.publicModelId)),
  );
  const requestedModelId = codexGatewayModelId(requestedModel);
  const selected =
    routableOpenAIModels.find(
      (model) => model.publicModelId === requestedModelId,
    ) ?? routableOpenAIModels[0];

  if (!selected) {
    throw new GatewayError(
      "No eligible OpenAI subscription account is available for web search",
      503,
      "NO_SEARCH_ACCOUNT_AVAILABLE",
    );
  }

  return resolveGatewayModel(selected.publicModelId);
};

const estimateSearchInputTokens = (
  request: CodexSearchRequest,
): { conservative: number; approximate: number } => {
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");

  return {
    conservative: Math.max(1, bytes + 256),
    approximate: Math.max(1, Math.ceil(bytes / 4) + 64),
  };
};

const searchFailureResponse = (
  failure: ProviderFailure,
  retryAt: Date | undefined,
): {
  message: string;
  status: 400 | 429 | 502;
  code: string;
  retryAt?: Date;
} => {
  if (failure.kind === "quota" || failure.kind === "rate-limit") {
    return {
      message: "Subscription account is quota-limited",
      status: 429,
      code: "UPSTREAM_QUOTA_LIMIT",
      ...(retryAt ? { retryAt } : {}),
    };
  }
  if (failure.kind === "invalid-request") {
    return {
      message: "The upstream provider rejected this request",
      status: 400,
      code: "INVALID_REQUEST",
    };
  }

  return {
    message: "Upstream provider request failed",
    status: 502,
    code: "UPSTREAM_FAILURE",
    ...(retryAt ? { retryAt } : {}),
  };
};

/** Execute Codex's standalone `web.run` request through an OpenAI subscription. */
export const proxyCodexSearchRequest = async (input: {
  principal: GatewayClientPrincipal;
  request: CodexSearchRequest;
  sessionHeader?: string;
  signal: AbortSignal;
}): Promise<Response> => {
  const model = await selectSearchModel(input.principal, input.request.model);
  const inputEstimate = estimateSearchInputTokens(input.request);
  const estimatedInputTokens = inputEstimate.conservative;
  const projectedOutputTokens = Math.min(
    model.maxOutputTokens ?? DEFAULT_SEARCH_OUTPUT_TOKENS,
    input.request.max_output_tokens ?? DEFAULT_SEARCH_OUTPUT_TOKENS,
  );
  const sessionId = normalizedSessionId(input.sessionHeader);
  const clientLease = await acquireClientLease(input.principal);
  const leaseGuard = createLeaseGuard({
    leases: [clientLease],
    ttlMs: LEASE_TTL_MS,
    heartbeatIntervalMs: LEASE_HEARTBEAT_MS,
    signal: input.signal,
    timeoutMs: MAX_INFERENCE_LIFETIME_MS,
  });
  let requestLog: { id: string };

  try {
    requestLog = await llmGatewayPrisma.gatewayRequestLog.create({
      data: {
        clientKeyId: input.principal.id,
        publicModelId: model.publicModelId,
        upstreamModelId: model.upstreamModelId,
        provider: model.provider,
        sessionHash: sessionId ? hmacGatewaySession(sessionId) : null,
        outcome: "started",
        streamed: false,
      },
      select: { id: true },
    });
  } catch (error) {
    await leaseGuard.finish();
    throw error;
  }
  let clientReservation: GatewayClientUsageReservation | null = null;
  let accountReservation: GatewayAccountUsageReservation | null = null;
  let accountAttemptDispatched = false;
  const refreshedAccounts = new Set<string>();
  const excludedAccounts = new Set<string>();
  const startedAt = Date.now();
  let lastAccountId: string | undefined;
  let lastRoutingPolicy: GatewayRoutingPolicy | undefined;
  const reconcileReservations = async (actual: {
    inputTokens?: number;
    outputTokens?: number;
    error?: boolean;
  }) => {
    const account = accountReservation;
    const client = clientReservation;

    accountReservation = null;
    clientReservation = null;
    await Promise.allSettled([
      ...(account ? [reconcileAccountUsageReservation(account, actual)] : []),
      ...(client ? [reconcileClientUsageReservation(client, actual)] : []),
    ]);
  };
  const finishLog = async (data: {
    outcome: string;
    statusCode: number;
    error?: unknown;
    retryCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    accountId?: string;
    routingPolicy?: GatewayRoutingPolicy;
  }) => {
    await llmGatewayPrisma.gatewayRequestLog
      .update({
        where: { id: requestLog.id },
        data: {
          outcome: data.outcome,
          statusCode: data.statusCode,
          errorClass: data.error instanceof Error ? data.error.name : null,
          retryCount: data.retryCount ?? 0,
          accountId: data.accountId,
          routingPolicy: data.routingPolicy,
          latencyMs: Date.now() - startedAt,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
  };

  try {
    clientReservation = await reserveClientDailyCapacity(input.principal, {
      modelId: model.id,
      estimatedInputTokens,
      requestedOutputTokens: projectedOutputTokens,
    });

    for (let attempt = 0; attempt < MAX_SEARCH_DISPATCHES; attempt += 1) {
      accountAttemptDispatched = false;
      const routed = await routeAccount({
        model,
        principal: input.principal,
        sessionId,
        estimatedInputTokens,
        estimatedOutputTokens: projectedOutputTokens,
        retry: attempt > 0,
        excludedAccountIds: excludedAccounts,
        requestKey: sessionId ?? input.request.id,
        leaseGuard,
      });

      accountReservation = routed.usageReservation;
      lastAccountId = routed.accountId;
      lastRoutingPolicy = routed.pool.policy;
      let attemptSettled = false;
      let terminalError = false;
      const reserveRetryClientCapacity = async () => {
        try {
          clientReservation = await reserveClientRetryCapacity(
            input.principal,
            {
              modelId: model.id,
              estimatedInputTokens,
              requestedOutputTokens: projectedOutputTokens,
            },
          );
        } catch (error) {
          terminalError = true;
          throw error;
        }
      };
      const reconcileBeforeRetry = async () => {
        if (attemptSettled) return;
        attemptSettled = true;
        await reconcileReservations({
          inputTokens: estimatedInputTokens,
          outputTokens: accountAttemptDispatched ? projectedOutputTokens : 0,
          error: true,
        });
        await leaseGuard.releaseLease(routed.accountLease);
      };

      try {
        leaseGuard.throwIfFailed();
        let credential = await loadCredential(routed.accountId);

        if (credential.secret.expiresAt <= Date.now() + 5 * 60 * 1000) {
          await refreshGatewayAccount(routed.accountId, {
            refreshCredential: true,
            signal: leaseGuard.signal,
          });
          credential = await loadCredential(routed.accountId);
        }
        const adapter = getProviderAdapter(fromDbProvider(model.provider));
        const prepared = await adapter.prepareSearch?.({
          request: input.request,
          upstreamModel: model.upstreamModelId,
          secret: credential.secret,
          identity: credential.identity,
          sessionId: sessionId ?? undefined,
          signal: leaseGuard.signal,
        });

        if (!prepared) {
          throw new GatewayError(
            "The selected subscription provider does not support web search",
            503,
            "SEARCH_UNSUPPORTED",
          );
        }
        leaseGuard.throwIfFailed();
        accountAttemptDispatched = true;
        const upstream = await fetch(prepared.url, {
          ...prepared.init,
          signal: leaseGuard.signal,
          redirect: "error",
        });

        leaseGuard.throwIfFailed();
        const quota = prepared.observeHeaders(upstream.headers);

        if (quota) {
          void persistGatewayHeaderQuota(
            routed.accountId,
            model.id,
            quota,
          ).catch(() => undefined);
        }
        if (!upstream.ok) {
          const failure = adapter.classifyFailure(
            upstream.status,
            upstream.headers,
          );
          const retryAt = failure.retryAfterMs
            ? new Date(Date.now() + failure.retryAfterMs)
            : undefined;

          await upstream.body?.cancel().catch(() => undefined);
          await reconcileBeforeRetry();

          if (
            failure.reauthenticate &&
            !refreshedAccounts.has(routed.accountId) &&
            attempt + 1 < MAX_SEARCH_DISPATCHES
          ) {
            refreshedAccounts.add(routed.accountId);
            try {
              await refreshGatewayAccount(routed.accountId, {
                refreshCredential: true,
                signal: leaseGuard.signal,
              });
              await reserveRetryClientCapacity();
              continue;
            } catch {
              // The normal retry path below will exclude this account.
            }
          }
          if (failure.reauthenticate) {
            await llmGatewayPrisma.gatewayProviderAccount
              .update({
                where: { id: routed.accountId },
                data: {
                  status: "REAUTH_REQUIRED",
                  healthReason: "Provider rejected the OAuth session",
                },
              })
              .catch(() => undefined);
          }
          if (failure.kind === "quota" || failure.kind === "rate-limit") {
            await llmGatewayPrisma.gatewayProviderAccount
              .update({
                where: { id: routed.accountId },
                data: {
                  cooldownUntil: retryAt ?? new Date(Date.now() + 60_000),
                },
              })
              .catch(() => undefined);
          }
          if (attempt + 1 < MAX_SEARCH_DISPATCHES && failure.retryable) {
            excludedAccounts.add(routed.accountId);
            await reserveRetryClientCapacity();
            continue;
          }
          terminalError = true;
          const publicFailure = searchFailureResponse(failure, retryAt);

          throw new GatewayError(
            publicFailure.message,
            publicFailure.status,
            publicFailure.code,
            publicFailure.retryAt,
          );
        }

        const search = await searchResponse(upstream);
        const billedOutputTokens = Math.min(
          projectedOutputTokens,
          search.outputTokens,
        );

        await reconcileReservations({
          inputTokens: inputEstimate.approximate,
          outputTokens: billedOutputTokens,
        });
        await llmGatewayPrisma.gatewayProviderAccount
          .update({
            where: { id: routed.accountId },
            data: { lastSuccessfulRequestAt: new Date(), cooldownUntil: null },
          })
          .catch(() => undefined);
        await finishLog({
          outcome: "success",
          statusCode: search.response.status,
          retryCount: attempt,
          inputTokens: inputEstimate.approximate,
          outputTokens: billedOutputTokens,
          accountId: routed.accountId,
          routingPolicy: routed.pool.policy,
        });
        await leaseGuard.finish();

        return search.response;
      } catch (error) {
        await reconcileBeforeRetry();
        if (leaseGuard.signal.aborted) throw leaseGuard.signal.reason ?? error;
        if (!terminalError && attempt + 1 < MAX_SEARCH_DISPATCHES) {
          excludedAccounts.add(routed.accountId);
          await reserveRetryClientCapacity();
          continue;
        }
        throw error;
      }
    }

    throw new GatewayError(
      "No subscription account completed the web search",
      503,
      "NO_SEARCH_ACCOUNT_AVAILABLE",
    );
  } catch (error) {
    await reconcileReservations({
      inputTokens: estimatedInputTokens,
      outputTokens: accountAttemptDispatched ? projectedOutputTokens : 0,
      error: true,
    });
    await finishLog({
      outcome: error instanceof GatewayError ? error.code : "internal_error",
      statusCode: error instanceof GatewayError ? error.status : 502,
      error,
      accountId: lastAccountId,
      routingPolicy: lastRoutingPolicy,
    });
    await leaseGuard.finish();
    throw error;
  }
};

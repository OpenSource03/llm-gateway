import type { GatewayClientPrincipal } from "../../control/client-keys.service";

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
import { resolveGatewayModel } from "../../control/models.service";
import Logger from "../../config/logger";
import { reconcileAccountUsageReservation } from "../account-usage";
import { llmGatewayPrisma } from "../db";
import { GatewayError } from "../errors";
import { createLeaseGuard } from "../leases";
import { getProviderAdapter, ProviderProtocolError } from "../providers";
import { fromDbProvider } from "../providers/provider-id";
import { hmacGatewaySession } from "../security/secrets";
import { UnsupportedAnthropicContentError } from "../translate";
import { lowerPlaintextCodexAgentMessages } from "../translate/codex-agent-messages";
import {
  MAX_ANTHROPIC_OUTPUT_TOKENS,
  type AnthropicMessagesRequest,
} from "../wire/anthropic";
import {
  codexGatewayModelId,
  type CodexResponsesRequest,
} from "../wire/codex-responses";
import {
  acquireClientLease,
  normalizedSessionId,
  persistGatewayHeaderQuota,
  routeAccount,
} from "./routing";
import {
  extractResponseUsage,
  type ObservedUsage,
  wrapStreamLifecycle,
} from "./stream-lifecycle";
import {
  estimateGatewayInputTokens,
  estimateGatewayResponsesInputTokens,
} from "./token-estimation";

const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_INFERENCE_LIFETIME_MS = 10 * 60_000;
const MAX_UPSTREAM_DISPATCHES = 4;

const providerMetadataFromCapabilities = (value: unknown): unknown =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).providerMetadata
    : undefined;

interface ProxyRequestBase {
  providerSessionHeader?: string;
  principal: GatewayClientPrincipal;
  sessionHeader?: string;
  signal: AbortSignal;
}

type ProxyGatewayRequest =
  | (ProxyRequestBase & {
      kind: "messages";
      request: AnthropicMessagesRequest;
    })
  | (ProxyRequestBase & {
      kind: "responses";
      request: CodexResponsesRequest;
    });

/** Execute one normalized gateway request with bounded alternate-account retries. */
const proxyGatewayRequest = async (
  input: ProxyGatewayRequest,
): Promise<Response> => {
  const requestedModelId =
    input.kind === "responses"
      ? codexGatewayModelId(input.request.model)
      : input.request.model;
  const model = await resolveGatewayModel(requestedModelId);

  if (
    input.kind === "messages" &&
    model.maxOutputTokens !== null &&
    input.request.max_tokens > model.maxOutputTokens
  ) {
    throw new GatewayError(
      `max_tokens exceeds this model's ${model.maxOutputTokens}-token output limit`,
      400,
      "MODEL_MAX_OUTPUT_EXCEEDED",
    );
  }

  if (
    !input.principal.allowAllModels &&
    !input.principal.allowedModelIds.has(model.publicModelId)
  ) {
    throw new GatewayError(
      "Gateway key cannot use this model",
      403,
      "MODEL_FORBIDDEN",
    );
  }
  const inputEstimate =
    input.kind === "responses"
      ? estimateGatewayResponsesInputTokens(input.request)
      : estimateGatewayInputTokens(input.request);
  const estimatedInputTokens = inputEstimate.conservative;
  const requestedOutputTokens =
    input.kind === "messages" ? input.request.max_tokens : 1;

  // The ChatGPT subscription backend currently rejects Responses'
  // max_output_tokens field. Reserve the discovered model maximum (or our
  // public hard maximum) so that omission can never bypass client/account
  // output caps; the adapter separately applies a conservative downstream
  // cutoff at the caller's requested max_tokens.
  const projectedOutputTokens =
    input.kind === "responses" || model.provider === "OPENAI"
      ? (model.maxOutputTokens ?? MAX_ANTHROPIC_OUTPUT_TOKENS)
      : requestedOutputTokens;

  const sessionId = normalizedSessionId(input.sessionHeader);
  // Codex intentionally shares `session-id` and `prompt_cache_key` between a
  // root and its subagents, while `thread-id` is unique. Preserve the shared
  // identity for sticky account routing, but give stateful providers the
  // thread-scoped identity so concurrent parent/child turns cannot collide.
  const providerSessionId = input.providerSessionHeader
    ? normalizedSessionId(input.providerSessionHeader)
    : sessionId;
  const clientLease = await acquireClientLease(input.principal);
  const leaseGuard = createLeaseGuard({
    leases: [clientLease],
    ttlMs: LEASE_TTL_MS,
    heartbeatIntervalMs: LEASE_HEARTBEAT_MS,
    signal: input.signal,
    timeoutMs: MAX_INFERENCE_LIFETIME_MS,
  });
  const excluded = new Set<string>();
  const refreshedAccounts = new Set<string>();
  const startedAt = new Date();
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
        streamed: input.request.stream === true,
      },
      select: { id: true },
    });
  } catch (error) {
    await leaseGuard.finish();
    throw error;
  }
  let currentAccountReconcile:
    | ((actual: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        error?: boolean;
      }) => Promise<void>)
    | null = null;

  type ReconcileClientAttempt = (actual: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    error?: boolean;
  }) => Promise<void>;
  let currentClientReconcile: ReconcileClientAttempt | null = null;
  let currentAttemptDispatched = false;
  const clientReconcilerFor = (
    reservation: GatewayClientUsageReservation,
  ): ReconcileClientAttempt => {
    let reconciled = false;
    const reconcile: ReconcileClientAttempt = async (actual) => {
      if (reconciled) return;
      try {
        await reconcileClientUsageReservation(reservation, actual);
        reconciled = true;
      } finally {
        // A failed reconciliation leaves the committed projection in place,
        // which is conservative. Do not let a later attempt's fallback apply
        // different usage to this older reservation.
        if (currentClientReconcile === reconcile) {
          currentClientReconcile = null;
        }
      }
    };

    return reconcile;
  };

  try {
    const initialClientReservation = await reserveClientDailyCapacity(
      input.principal,
      {
        modelId: model.id,
        estimatedInputTokens,
        requestedOutputTokens: projectedOutputTokens,
      },
    );

    currentClientReconcile = clientReconcilerFor(initialClientReservation);
    for (let attempt = 0; attempt < MAX_UPSTREAM_DISPATCHES; attempt += 1) {
      currentAttemptDispatched = false;
      const routed = await routeAccount({
        model,
        principal: input.principal,
        sessionId,
        estimatedInputTokens,
        estimatedOutputTokens: projectedOutputTokens,
        retry: attempt > 0,
        excludedAccountIds: excluded,
        requestKey: sessionId ?? requestLog.id,
        leaseGuard,
      });

      let accountReservationReconciled = false;
      const reconcileRoutedAccount = async (actual: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        error?: boolean;
      }) => {
        if (accountReservationReconciled) return;
        await reconcileAccountUsageReservation(routed.usageReservation, actual);
        accountReservationReconciled = true;
        if (currentAccountReconcile === reconcileRoutedAccount) {
          currentAccountReconcile = null;
        }
      };

      currentAccountReconcile = reconcileRoutedAccount;
      if (attempt > 0) {
        let retryReservation: GatewayClientUsageReservation;

        try {
          retryReservation = await reserveClientRetryCapacity(input.principal, {
            modelId: model.id,
            estimatedInputTokens,
            requestedOutputTokens: projectedOutputTokens,
          });
        } catch (error) {
          await Promise.allSettled([
            reconcileRoutedAccount({
              inputTokens: estimatedInputTokens,
              outputTokens: 0,
              error: true,
            }),
            leaseGuard.releaseLease(routed.accountLease),
          ]);
          throw error;
        }
        currentClientReconcile = clientReconcilerFor(retryReservation);
      }
      const reconcileClientAttempt = currentClientReconcile;

      if (!reconcileClientAttempt) {
        throw new GatewayError(
          "Client attempt reservation is unavailable",
          503,
          "CLIENT_RESERVATION_UNAVAILABLE",
        );
      }
      const adapter = getProviderAdapter(fromDbProvider(model.provider));
      const providerMetadata = providerMetadataFromCapabilities(
        model.capabilities,
      );
      const upstreamSignal = leaseGuard.signal;
      let credential: Awaited<ReturnType<typeof loadCredential>> | null = null;
      let prepared: Awaited<ReturnType<typeof adapter.prepareInference>>;
      const reconcileUndispatchedAttempt = () =>
        Promise.allSettled([
          reconcileRoutedAccount({
            inputTokens: estimatedInputTokens,
            outputTokens: 0,
            error: true,
          }),
          reconcileClientAttempt({
            inputTokens: estimatedInputTokens,
            outputTokens: 0,
            error: true,
          }),
        ]);

      if (routed.transport.id === "direct") {
        try {
          leaseGuard.throwIfFailed();
          credential = await loadCredential(routed.accountId);

          if (credential.secret.expiresAt <= Date.now() + 5 * 60 * 1000) {
            await refreshGatewayAccount(routed.accountId, {
              refreshCredential: true,
              signal: upstreamSignal,
            });
            credential = await loadCredential(routed.accountId);
          }
          leaseGuard.throwIfFailed();
        } catch (error) {
          const refreshRejected =
            (error instanceof ProviderProtocolError &&
              (error.status === 400 || error.status === 401)) ||
            (error instanceof GatewayError &&
              error.code === "ACCOUNT_REAUTH_REQUIRED");
          const refreshContended =
            error instanceof GatewayError &&
            error.code === "REFRESH_IN_PROGRESS";
          const interrupted = upstreamSignal.aborted;

          if (!interrupted && !refreshContended) {
            await llmGatewayPrisma.gatewayProviderAccount
              .update({
                where: { id: routed.accountId },
                data: refreshRejected
                  ? {
                      status: "REAUTH_REQUIRED",
                      healthReason: "Provider rejected the OAuth session",
                    }
                  : {
                      status: "ERROR",
                      healthReason: "Credential preparation failed",
                    },
              })
              .catch(() => undefined);
          }
          await reconcileUndispatchedAttempt();
          if (interrupted) throw upstreamSignal.reason ?? error;
          if (attempt + 1 < MAX_UPSTREAM_DISPATCHES) {
            excluded.add(routed.accountId);
            await leaseGuard.releaseLease(routed.accountLease);
            continue;
          }
          throw new GatewayError(
            "No subscription account could prepare the request",
            503,
            "ACCOUNT_CREDENTIAL_UNAVAILABLE",
          );
        }
      }

      try {
        if (input.kind === "responses" && routed.transport.id === "agent-sdk") {
          if (!adapter.prepareExternalResponsesInference) {
            throw new ProviderProtocolError(
              "Provider does not support this external transport",
              503,
            );
          }
          prepared = await adapter.prepareExternalResponsesInference({
            request: input.request,
            upstreamModel: model.upstreamModelId,
            publicModel: model.publicModelId,
            identity: routed.identity,
            providerMetadata,
            transport: routed.transport,
            sessionId: providerSessionId ?? undefined,
            projectedInputTokens: estimatedInputTokens,
            projectedOutputTokens,
            signal: upstreamSignal,
          });
        } else if (
          input.kind === "messages" &&
          routed.transport.id === "agent-sdk"
        ) {
          if (!adapter.prepareExternalInference) {
            throw new ProviderProtocolError(
              "Provider does not support this external transport",
              503,
            );
          }
          prepared = await adapter.prepareExternalInference({
            request: { ...input.request, model: model.upstreamModelId },
            upstreamModel: model.upstreamModelId,
            publicModel: model.publicModelId,
            identity: routed.identity,
            providerMetadata,
            transport: routed.transport,
            sessionId: providerSessionId ?? undefined,
            projectedInputTokens: estimatedInputTokens,
            projectedOutputTokens,
            signal: upstreamSignal,
          });
        } else if (input.kind === "responses") {
          prepared = await adapter.prepareResponsesInference({
            request: input.request,
            upstreamModel: model.upstreamModelId,
            publicModel: model.publicModelId,
            secret: credential!.secret,
            identity: credential!.identity,
            providerMetadata,
            sessionId: providerSessionId ?? undefined,
            projectedInputTokens: estimatedInputTokens,
            projectedOutputTokens,
            signal: upstreamSignal,
          });
        } else {
          prepared = await adapter.prepareInference({
            request: { ...input.request, model: model.upstreamModelId },
            upstreamModel: model.upstreamModelId,
            publicModel: model.publicModelId,
            secret: credential!.secret,
            identity: credential!.identity,
            providerMetadata,
            sessionId: providerSessionId ?? undefined,
            projectedInputTokens: estimatedInputTokens,
            projectedOutputTokens,
            signal: upstreamSignal,
          });
        }
        leaseGuard.throwIfFailed();
      } catch (error) {
        const invalidRequest =
          error instanceof TypeError ||
          error instanceof UnsupportedAnthropicContentError ||
          (error instanceof ProviderProtocolError &&
            error.status === undefined);

        await reconcileUndispatchedAttempt();
        if (upstreamSignal.aborted) throw upstreamSignal.reason ?? error;
        if (invalidRequest) {
          throw new GatewayError(
            "The request cannot be represented for this provider",
            400,
            "INVALID_REQUEST",
          );
        }
        await llmGatewayPrisma.gatewayProviderAccount
          .update({
            where: { id: routed.accountId },
            data: {
              status: "ERROR",
              healthReason: "Provider request preparation failed",
            },
          })
          .catch(() => undefined);
        if (attempt + 1 < MAX_UPSTREAM_DISPATCHES) {
          excluded.add(routed.accountId);
          await leaseGuard.releaseLease(routed.accountLease);
          continue;
        }
        throw new GatewayError(
          "No subscription account could prepare the request",
          503,
          "ACCOUNT_CREDENTIAL_UNAVAILABLE",
        );
      }
      let upstream: Response;

      try {
        currentAttemptDispatched = true;
        upstream = await fetch(prepared.url, {
          ...prepared.init,
          signal: upstreamSignal,
          redirect: "error",
        });
        leaseGuard.throwIfFailed();
      } catch (error) {
        // Once dispatch begins, an aborted/failed fetch may still have consumed
        // provider quota even though no response usage reached us. Keep this
        // account's full projection. Never retry an already-aborted request.
        const aborted = upstreamSignal.aborted || input.signal.aborted;

        await Promise.allSettled([
          reconcileRoutedAccount({
            inputTokens: estimatedInputTokens,
            outputTokens: projectedOutputTokens,
            error: true,
          }),
          reconcileClientAttempt({
            inputTokens: estimatedInputTokens,
            outputTokens: projectedOutputTokens,
            error: true,
          }),
        ]);
        if (!aborted && attempt + 1 < MAX_UPSTREAM_DISPATCHES) {
          excluded.add(routed.accountId);
          await leaseGuard.releaseLease(routed.accountLease);
          continue;
        }
        throw error;
      }
      const quota = prepared.observeHeaders(upstream.headers);

      if (quota) {
        void persistGatewayHeaderQuota(routed.accountId, model.id, quota).catch(
          (error) =>
            Logger.warn("Gateway response quota persistence failed", {
              accountId: routed.accountId,
              errorType: error instanceof Error ? error.name : "UnknownError",
            }),
        );
      }
      if (!upstream.ok) {
        const failure = (prepared.classifyFailure ?? adapter.classifyFailure)(
          upstream.status,
          upstream.headers,
        );
        const retryAt = failure.retryAfterMs
          ? new Date(Date.now() + failure.retryAfterMs)
          : undefined;
        const failureOutputTokens =
          failure.kind === "transient" || failure.kind === "unknown"
            ? projectedOutputTokens
            : 0;

        // OAuth access tokens can be rejected before their advertised expiry.
        // Refresh each account at most once, then give a different eligible
        // subscription the remaining bounded dispatch budget.
        if (
          routed.transport.id === "direct" &&
          failure.reauthenticate &&
          !refreshedAccounts.has(routed.accountId) &&
          attempt + 1 < MAX_UPSTREAM_DISPATCHES
        ) {
          await upstream.body?.cancel().catch(() => undefined);
          refreshedAccounts.add(routed.accountId);
          try {
            await refreshGatewayAccount(routed.accountId, {
              refreshCredential: true,
              signal: upstreamSignal,
            });
            await Promise.allSettled([
              reconcileRoutedAccount({
                inputTokens: estimatedInputTokens,
                outputTokens: failureOutputTokens,
                error: true,
              }),
              reconcileClientAttempt({
                inputTokens: estimatedInputTokens,
                outputTokens: failureOutputTokens,
                error: true,
              }),
            ]);
            await leaseGuard.releaseLease(routed.accountLease);
            continue;
          } catch (refreshError) {
            if (upstreamSignal.aborted) {
              throw upstreamSignal.reason ?? refreshError;
            }
            // A failed refresh is deliberately reduced to a health state. Raw
            // provider/OAuth error bodies never enter logs or the database.
          }
        }
        if (failure.reauthenticate) {
          await llmGatewayPrisma.gatewayProviderAccount.update({
            where: { id: routed.accountId },
            data: {
              status: "REAUTH_REQUIRED",
              healthReason: "Provider rejected the OAuth session",
            },
          });
        }
        if (failure.kind === "quota" || failure.kind === "rate-limit") {
          await llmGatewayPrisma.gatewayProviderAccount.update({
            where: { id: routed.accountId },
            data: { cooldownUntil: retryAt ?? new Date(Date.now() + 60_000) },
          });
        }
        if (
          attempt + 1 < MAX_UPSTREAM_DISPATCHES &&
          (failure.retryable || failure.reauthenticate)
        ) {
          await upstream.body?.cancel().catch(() => undefined);
          excluded.add(routed.accountId);
          await Promise.allSettled([
            reconcileRoutedAccount({
              inputTokens: estimatedInputTokens,
              outputTokens: failureOutputTokens,
              error: true,
            }),
            reconcileClientAttempt({
              inputTokens: estimatedInputTokens,
              outputTokens: failureOutputTokens,
              error: true,
            }),
          ]);
          await leaseGuard.releaseLease(routed.accountLease);
          continue;
        }
        await upstream.body?.cancel().catch(() => undefined);
        await Promise.allSettled([
          reconcileRoutedAccount({
            inputTokens: estimatedInputTokens,
            outputTokens: failureOutputTokens,
            error: true,
          }),
          reconcileClientAttempt({
            inputTokens: estimatedInputTokens,
            outputTokens: failureOutputTokens,
            error: true,
          }),
        ]);
        if (failure.kind === "invalid-request") {
          throw new GatewayError(
            "The upstream provider rejected this request",
            400,
            "INVALID_REQUEST",
          );
        }
        throw new GatewayError(
          failure.kind === "quota" || failure.kind === "rate-limit"
            ? "Subscription account is quota-limited"
            : "Upstream provider request failed",
          failure.kind === "quota" || failure.kind === "rate-limit" ? 429 : 502,
          failure.kind === "quota" || failure.kind === "rate-limit"
            ? "UPSTREAM_QUOTA_LIMIT"
            : "UPSTREAM_FAILURE",
          retryAt,
        );
      }

      let response: Response;

      try {
        response = await prepared.transformResponse(upstream);
        leaseGuard.throwIfFailed();
      } catch (error) {
        await upstream.body?.cancel(error).catch(() => undefined);
        const aborted = upstreamSignal.aborted || input.signal.aborted;

        await Promise.allSettled([
          reconcileRoutedAccount({
            inputTokens: estimatedInputTokens,
            outputTokens: projectedOutputTokens,
            error: true,
          }),
          reconcileClientAttempt({
            inputTokens: estimatedInputTokens,
            outputTokens: projectedOutputTokens,
            error: true,
          }),
        ]);
        if (!aborted && attempt + 1 < MAX_UPSTREAM_DISPATCHES) {
          excluded.add(routed.accountId);
          await leaseGuard.releaseLease(routed.accountLease);
          continue;
        }
        throw error;
      }
      const finalize = async (
        error?: unknown,
        streamedUsage?: ObservedUsage,
      ) => {
        const observedUsage =
          streamedUsage ??
          (error
            ? {}
            : await extractResponseUsage(response, prepared.publicProtocol));
        // Partial message_start usage is commonly zero. On any cancellation,
        // truncation, or error, usage is incomplete and cannot reopen reserved
        // capacity; trust it only after a clean terminal completion.
        const usage = error ? {} : observedUsage;
        const billedInputTokens = usage.input ?? estimatedInputTokens;
        // Once a 2xx response has started, missing terminal usage is unknown,
        // not zero. Retain the reserved maximum on truncation/cancellation so
        // a client cannot bypass output caps by repeatedly aborting streams.
        const billedOutputTokens = usage.output ?? projectedOutputTokens;

        await Promise.allSettled([
          llmGatewayPrisma.gatewayRequestLog.update({
            where: { id: requestLog.id },
            data: {
              accountId: routed.accountId,
              routingPolicy: routed.pool.policy,
              statusCode: error ? 502 : response.status,
              outcome: error ? "stream_error" : "success",
              errorClass: error instanceof Error ? error.name : null,
              retryCount: attempt,
              latencyMs: Date.now() - startedAt.getTime(),
              inputTokens: billedInputTokens,
              outputTokens: billedOutputTokens,
              cachedInputTokens: usage.cached,
              completedAt: new Date(),
            },
          }),
          reconcileRoutedAccount({
            inputTokens: billedInputTokens,
            outputTokens: billedOutputTokens,
            cachedInputTokens: usage.cached,
            error: Boolean(error),
          }),
          reconcileClientAttempt({
            inputTokens: billedInputTokens,
            outputTokens: billedOutputTokens,
            cachedInputTokens: usage.cached,
            error: Boolean(error),
          }),
          llmGatewayPrisma.gatewayProviderAccount.update({
            where: { id: routed.accountId },
            data: error
              ? {}
              : { lastSuccessfulRequestAt: new Date(), cooldownUntil: null },
          }),
        ]);
      };

      if (input.request.stream && response.body) {
        return wrapStreamLifecycle(response, leaseGuard, finalize, {
          publicProtocol: prepared.publicProtocol,
        });
      }

      leaseGuard.throwIfFailed();
      await finalize();
      await leaseGuard.finish();

      return response;
    }

    throw new GatewayError(
      "No account completed the request",
      503,
      "NO_ACCOUNT_AVAILABLE",
    );
  } catch (error) {
    await leaseGuard.finish();
    if (currentAccountReconcile) {
      await currentAccountReconcile({
        inputTokens: estimatedInputTokens,
        outputTokens: currentAttemptDispatched ? projectedOutputTokens : 0,
        error: true,
      }).catch(() => undefined);
    }
    if (currentClientReconcile) {
      await currentClientReconcile({
        inputTokens: estimatedInputTokens,
        outputTokens: currentAttemptDispatched ? projectedOutputTokens : 0,
        error: true,
      }).catch(() => undefined);
    }
    await llmGatewayPrisma.gatewayRequestLog
      .update({
        where: { id: requestLog.id },
        data: {
          outcome:
            error instanceof GatewayError ? error.code : "internal_error",
          errorClass: error instanceof Error ? error.name : "UnknownError",
          statusCode: error instanceof GatewayError ? error.status : 502,
          latencyMs: Date.now() - startedAt.getTime(),
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw error;
  }
};

/** Execute one Anthropic Messages request through the shared gateway core. */
export const proxyMessagesRequest = async (input: {
  principal: GatewayClientPrincipal;
  request: AnthropicMessagesRequest;
  sessionHeader?: string;
  signal: AbortSignal;
}): Promise<Response> => proxyGatewayRequest({ kind: "messages", ...input });

/** Execute one native Codex Responses request through the shared gateway core. */
export const proxyResponsesRequest = async (input: {
  providerSessionHeader?: string;
  principal: GatewayClientPrincipal;
  request: CodexResponsesRequest;
  sessionHeader?: string;
  signal: AbortSignal;
}): Promise<Response> =>
  proxyGatewayRequest({
    kind: "responses",
    ...input,
    request: lowerPlaintextCodexAgentMessages(input.request),
  });

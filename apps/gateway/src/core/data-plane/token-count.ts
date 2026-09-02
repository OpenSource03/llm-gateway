import type { GatewayClientPrincipal } from "../../control/client-keys.service";

import { randomUUID } from "node:crypto";

import {
  reconcileClientUsageReservation,
  reserveClientDailyCapacity,
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
import { getProviderAdapter, readBoundedText } from "../providers";
import type { AnthropicMessagesRequest } from "../wire/anthropic";
import { secureDataPlaneHeaders } from "./response-headers";
import {
  acquireClientLease,
  normalizedSessionId,
  persistGatewayHeaderQuota,
  routeAccount,
} from "./routing";
import {
  estimateGatewayInputTokens,
} from "./token-estimation";

const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_TOKEN_COUNT_LIFETIME_MS = 60_000;
const MAX_UPSTREAM_DISPATCHES = 4;
const MAX_TOKEN_COUNT_RESPONSE_BYTES = 256 * 1024;

export const countGatewayTokens = async (input: {
  principal: GatewayClientPrincipal;
  request: AnthropicMessagesRequest;
  sessionHeader?: string;
  signal: AbortSignal;
}): Promise<Response> => {
  const model = await resolveGatewayModel(input.request.model);

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
  const inputEstimate = estimateGatewayInputTokens(input.request);
  const estimated = inputEstimate.conservative;

  const sessionId = normalizedSessionId(input.sessionHeader);

  if (model.provider !== "ANTHROPIC") {
    await reserveClientDailyCapacity(input.principal, {
      modelId: model.id,
      estimatedInputTokens: estimated,
    });

    return Response.json(
      { input_tokens: estimated, estimated: true },
      { headers: secureDataPlaneHeaders() },
    );
  }

  const clientLease = await acquireClientLease(input.principal);
  const leaseGuard = createLeaseGuard({
    leases: [clientLease],
    ttlMs: LEASE_TTL_MS,
    heartbeatIntervalMs: LEASE_HEARTBEAT_MS,
    signal: input.signal,
    timeoutMs: MAX_TOKEN_COUNT_LIFETIME_MS,
  });
  let reservation: GatewayClientUsageReservation | null = null;
  let failed = true;
  const excluded = new Set<string>();
  const refreshedAccounts = new Set<string>();
  const adapter = getProviderAdapter("anthropic");

  try {
    reservation = await reserveClientDailyCapacity(input.principal, {
      modelId: model.id,
      estimatedInputTokens: estimated,
    });
    for (let attempt = 0; attempt < MAX_UPSTREAM_DISPATCHES; attempt += 1) {
      const routed = await routeAccount({
        model,
        principal: input.principal,
        sessionId,
        estimatedInputTokens: estimated,
        estimatedOutputTokens: 0,
        retry: attempt > 0,
        excludedAccountIds: excluded,
        requestKey: randomUUID(),
        leaseGuard,
      });

      let accountFailed = true;

      try {
        const upstreamSignal = leaseGuard.signal;

        leaseGuard.throwIfFailed();
        if (routed.transport.id === "agent-sdk") {
          accountFailed = false;
          failed = false;

          return Response.json(
            { input_tokens: inputEstimate.approximate, estimated: true },
            { headers: secureDataPlaneHeaders() },
          );
        }
        let credential = await loadCredential(routed.accountId);

        if (credential.secret.expiresAt <= Date.now() + 5 * 60 * 1000) {
          refreshedAccounts.add(routed.accountId);
          await refreshGatewayAccount(routed.accountId, {
            refreshCredential: true,
            signal: upstreamSignal,
          });
          credential = await loadCredential(routed.accountId);
        }
        leaseGuard.throwIfFailed();
        const prepared = await adapter.prepareTokenCount?.({
          request: {
            ...input.request,
            model: model.upstreamModelId,
            stream: false,
          },
          upstreamModel: model.upstreamModelId,
          publicModel: model.publicModelId,
          secret: credential.secret,
          identity: credential.identity,
          sessionId: sessionId ?? undefined,
          signal: upstreamSignal,
        });

        leaseGuard.throwIfFailed();

        if (!prepared) {
          throw new GatewayError(
            "Provider does not support token counting",
            502,
            "TOKEN_COUNT_UNSUPPORTED",
          );
        }
        const response = await fetch(prepared.url, {
          ...prepared.init,
          signal: upstreamSignal,
          redirect: "error",
        });

        leaseGuard.throwIfFailed();
        const quota = prepared.observeHeaders(response.headers);

        if (quota) {
          void persistGatewayHeaderQuota(
            routed.accountId,
            model.id,
            quota,
          ).catch((error) =>
            Logger.warn("Gateway response quota persistence failed", {
              accountId: routed.accountId,
              errorType: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const failure = adapter.classifyFailure(
            response.status,
            response.headers,
          );
          const retryAt = failure.retryAfterMs
            ? new Date(Date.now() + failure.retryAfterMs)
            : undefined;

          if (
            failure.reauthenticate &&
            !refreshedAccounts.has(routed.accountId) &&
            attempt + 1 < MAX_UPSTREAM_DISPATCHES
          ) {
            refreshedAccounts.add(routed.accountId);
            try {
              await refreshGatewayAccount(routed.accountId, {
                refreshCredential: true,
                signal: upstreamSignal,
              });
              accountFailed = true;
              // Keep this account eligible for its single refreshed retry.
              continue;
            } catch {
              // Mark/exclude it below and route another subscription.
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
              data: {
                cooldownUntil: retryAt ?? new Date(Date.now() + 60_000),
              },
            });
          }
          if (
            attempt + 1 < MAX_UPSTREAM_DISPATCHES &&
            (failure.retryable || failure.reauthenticate)
          ) {
            excluded.add(routed.accountId);
            continue;
          }
          throw new GatewayError(
            failure.kind === "quota" || failure.kind === "rate-limit"
              ? "Subscription account is quota-limited"
              : "Token count failed",
            failure.kind === "quota" || failure.kind === "rate-limit"
              ? 429
              : 502,
            failure.kind === "quota" || failure.kind === "rate-limit"
              ? "UPSTREAM_QUOTA_LIMIT"
              : "TOKEN_COUNT_FAILED",
            retryAt,
          );
        }
        const responseBody = await readBoundedText(
          response,
          MAX_TOKEN_COUNT_RESPONSE_BYTES,
        );
        const headers = new Headers({
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        });
        const requestId = response.headers.get("request-id");

        if (requestId) headers.set("request-id", requestId);
        secureDataPlaneHeaders(headers);
        accountFailed = false;
        failed = false;

        return new Response(responseBody, {
          status: response.status,
          headers,
        });
      } catch (error) {
        if (leaseGuard.signal.aborted) {
          throw leaseGuard.signal.reason ?? error;
        }
        if (
          attempt + 1 >= MAX_UPSTREAM_DISPATCHES ||
          (error instanceof GatewayError &&
            ["TOKEN_COUNT_UNSUPPORTED", "TOKEN_COUNT_FAILED"].includes(
              error.code,
            ))
        ) {
          throw error;
        }
        excluded.add(routed.accountId);
      } finally {
        await Promise.allSettled([
          leaseGuard.releaseLease(routed.accountLease),
          reconcileAccountUsageReservation(routed.usageReservation, {
            inputTokens: estimated,
            outputTokens: 0,
            error: accountFailed,
          }),
        ]);
      }
    }

    throw new GatewayError(
      "No subscription account could count tokens",
      503,
      "NO_ACCOUNT_AVAILABLE",
    );
  } finally {
    await leaseGuard.finish();
    if (failed && reservation) {
      await reconcileClientUsageReservation(reservation, { error: true }).catch(
        () => undefined,
      );
    }
  }
};

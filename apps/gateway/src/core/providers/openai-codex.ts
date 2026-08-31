import type {
  AdapterDependencies,
  DiscoveredModel,
  LoginProgress,
  OAuthPrivateState,
  OAuthSecret,
  ProviderIdentity,
  QuotaSnapshot,
  QuotaWindow,
  SubscriptionProviderAdapter,
} from "./types";

import { anthropicToResponses } from "../translate/anthropic-to-responses";
import { transformResponsesResponse } from "../translate/responses-to-anthropic";
import { sanitizeCodexResponsesStream } from "../translate/sanitize-codex-responses";

import {
  DEFAULT_ADAPTER_DEPENDENCIES,
  ProviderProtocolError,
  assertRecord,
  clampFraction,
  classifyHttpFailure,
  decodeJwtPayload,
  expectJson,
  fetchWithTimeout,
  finiteNumber,
  isRecord,
  mergeHeadersForPublicResponse,
  nonEmptyString,
  MAX_PROVIDER_MODEL_ROWS,
  providerModelId,
  normalizeSessionId,
  quotaStatus,
  stableUuid,
} from "./shared";

export const OPENAI_CODEX_ENDPOINTS = {
  deviceStart: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  devicePoll: "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceVerification: "https://auth.openai.com/codex/device",
  deviceRedirect: "https://auth.openai.com/deviceauth/callback",
  token: "https://auth.openai.com/oauth/token",
  base: "https://chatgpt.com/backend-api",
  responses: "https://chatgpt.com/backend-api/codex/responses",
  usage: "https://chatgpt.com/backend-api/wham/usage",
  search: "https://chatgpt.com/backend-api/codex/alpha/search",
} as const;

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLIENT_VERSION = "0.144.1";
const TOKEN_SKEW_MS = 5 * 60_000;
const DEFAULT_DEVICE_TTL_SECONDS = 600;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

const CODEX_CATALOG_KEYS = [
  "slug",
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "additional_speed_tiers",
  "service_tiers",
  "default_service_tier",
  "availability_nux",
  "upgrade",
  "model_messages",
  "base_instructions",
  "include_skills_usage_instructions",
  "include_plugin_usage_instructions",
  "include_apps_usage_instructions",
  "supports_reasoning_summary_parameter",
  "default_reasoning_summary",
  "support_verbosity",
  "default_verbosity",
  "apply_patch_tool_type",
  "web_search_tool_type",
  "truncation_policy",
  "supports_image_detail_original",
  "context_window",
  "max_context_window",
  "auto_compact_token_limit",
  "comp_hash",
  "effective_context_window_percent",
  "experimental_supported_tools",
  "input_modalities",
  "supports_search_tool",
  "use_responses_lite",
  "node_repl_auto_review_required",
  "node_repl_disabled",
  "auto_review_model_override",
  "model_specialty",
  "tool_mode",
  "multi_agent_version",
  "prefer_websockets",
  "supports_parallel_tool_calls",
  "minimal_client_version",
] as const;

interface OpenAIDeviceState extends OAuthPrivateState {
  provider: "openai";
  flow: "device-code";
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}

export function createOpenAICodexProviderAdapter(
  overrides: Partial<AdapterDependencies> = {},
): SubscriptionProviderAdapter {
  const deps = { ...DEFAULT_ADAPTER_DEPENDENCIES, ...overrides };

  return {
    id: "openai",
    codexCatalog: {
      modelIdSource: "upstream",
      supportsSearchTool: false,
      toolMode: "direct",
      webSearchToolType: null,
    },

    async startLogin(signal) {
      const response = await fetchWithTimeout(
        deps.fetch,
        OPENAI_CODEX_ENDPOINTS.deviceStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ client_id: CLIENT_ID }),
        },
        15_000,
        signal,
      );
      const payload = assertRecord(
        await expectJson(response, "OpenAI device authorization", 64 * 1024),
        "OpenAI device authorization response",
      );
      const deviceAuthId = nonEmptyString(payload.device_auth_id);
      const userCode = nonEmptyString(payload.user_code);
      const intervalSeconds = finiteNumber(payload.interval) ?? 5;
      const expiresInSeconds =
        finiteNumber(payload.expires_in) ?? DEFAULT_DEVICE_TTL_SECONDS;

      if (
        !deviceAuthId ||
        !userCode ||
        intervalSeconds <= 0 ||
        expiresInSeconds <= 0
      ) {
        throw new ProviderProtocolError(
          "OpenAI device authorization omitted required fields",
        );
      }
      const intervalMs = intervalSeconds * 1_000 + 3_000;
      const expiresAt = deps.now() + expiresInSeconds * 1_000;
      const privateState: OpenAIDeviceState = {
        provider: "openai",
        flow: "device-code",
        deviceAuthId,
        userCode,
        intervalMs,
        expiresAt,
      };

      return {
        kind: "device-code",
        verificationUrl: OPENAI_CODEX_ENDPOINTS.deviceVerification,
        userCode,
        intervalMs,
        expiresAt,
        privateState,
      };
    },

    async continueLogin(
      rawState,
      _pastedInput,
      signal,
    ): Promise<LoginProgress> {
      const state = parseDeviceState(rawState);

      if (state.expiresAt <= deps.now())
        return { kind: "expired", message: "OpenAI device code expired" };
      const response = await fetchWithTimeout(
        deps.fetch,
        OPENAI_CODEX_ENDPOINTS.devicePoll,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            device_auth_id: state.deviceAuthId,
            user_code: state.userCode,
          }),
        },
        15_000,
        signal,
      );

      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);

        return { kind: "pending", nextPollAt: deps.now() + state.intervalMs };
      }
      const payload = assertRecord(
        await expectJson(response, "OpenAI device token polling", 64 * 1024),
        "OpenAI device token response",
      );
      const authorizationCode = nonEmptyString(payload.authorization_code);
      const verifier = nonEmptyString(payload.code_verifier);

      if (!authorizationCode || !verifier) {
        throw new ProviderProtocolError(
          "OpenAI device token response omitted the authorization code",
        );
      }
      const tokenPayload = await exchangeToken(
        deps,
        authorizationCode,
        verifier,
        signal,
      );
      const secret = parseToken(tokenPayload, deps.now());

      return {
        kind: "complete",
        secret,
        identity: extractOpenAIIdentity(
          secret.accessToken,
          nonEmptyString(tokenPayload.id_token),
        ),
      };
    },

    async refresh(secret, signal) {
      const response = await fetchWithTimeout(
        deps.fetch,
        OPENAI_CODEX_ENDPOINTS.token,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: secret.refreshToken,
            client_id: CLIENT_ID,
          }),
        },
        15_000,
        signal,
      );
      const payload = assertRecord(
        await expectJson(response, "OpenAI token refresh", 64 * 1024),
        "OpenAI token response",
      );
      const refreshed = parseToken(payload, deps.now(), secret.refreshToken);
      const profile = extractOpenAIProfile(
        refreshed.accessToken,
        nonEmptyString(payload.id_token),
      );

      return {
        secret: refreshed,
        identityPatch: { email: profile.email, plan: profile.plan },
      };
    },

    async discover(secret, signal) {
      const identity = extractOpenAIIdentity(
        secret.accessToken,
        secret.idToken,
      );
      const headers = codexHeaders(
        secret.accessToken,
        identity.externalWorkspaceId,
        false,
      );

      let discoveredModels: DiscoveredModel[] = [];
      const nativeCatalog = new Map<string, Record<string, unknown>>();
      let catalogEtag: string | undefined;

      for (const path of ["/codex/models", "/models"]) {
        const url = new URL(`${OPENAI_CODEX_ENDPOINTS.base}${path}`);

        url.searchParams.set("client_version", CLIENT_VERSION);
        const response = await fetchWithTimeout(
          deps.fetch,
          url,
          { method: "GET", headers },
          15_000,
          signal,
        );

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        const payload = await expectJson(
          response,
          "OpenAI model discovery",
          512 * 1024,
        );
        const models = parseCodexModels(
          payload,
          response.headers.get("etag") ?? undefined,
        );

        if (discoveredModels.length === 0 && models.length > 0) {
          discoveredModels = models;
        }
        catalogEtag ??= response.headers.get("etag") ?? undefined;
        for (const entry of parseCodexCatalog(payload)) {
          const slug = typeof entry.slug === "string" ? entry.slug : null;

          if (slug && !nativeCatalog.has(slug)) nativeCatalog.set(slug, entry);
        }
      }
      if (discoveredModels.length > 0) {
        return {
          models: discoveredModels,
          nativeCatalog: {
            entries: [...nativeCatalog.values()],
            ...(catalogEtag ? { etag: catalogEtag } : {}),
          },
        };
      }
      throw new ProviderProtocolError(
        "OpenAI model discovery failed on every supported route",
      );
    },

    async fetchQuota(secret, identity, signal) {
      const response = await fetchWithTimeout(
        deps.fetch,
        OPENAI_CODEX_ENDPOINTS.usage,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${secret.accessToken}`,
            "ChatGPT-Account-Id":
              identity.externalWorkspaceId ?? identity.externalAccountId,
            "User-Agent": "OpenCode-Status-Plugin/1.0",
            Accept: "application/json",
          },
        },
        15_000,
        signal,
      );
      const payload = await expectJson(
        response,
        "OpenAI quota lookup",
        256 * 1024,
      );

      return parseCodexQuota(payload, deps.now());
    },

    async prepareInference(input) {
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const body = anthropicToResponses(input.request, {
        model: input.upstreamModel,
        provider: "openai",
        sessionId,
        omitMaxOutputTokens: true,
        supportsReasoningEffort: true,
      });

      body.store = false;
      body.stream = true;
      const workspaceId =
        input.identity.externalWorkspaceId ?? input.identity.externalAccountId;
      const headers = codexInferenceHeaders(
        input.secret.accessToken,
        workspaceId,
        sessionId,
        body.model,
        typeof body.service_tier === "string" ? body.service_tier : undefined,
      );

      return {
        url: OPENAI_CODEX_ENDPOINTS.responses,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: input.signal,
        },
        protocol: "responses",
        publicProtocol: "anthropic",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: (responseHeaders) =>
          parseCodexQuotaHeaders(responseHeaders, deps.now()),
        transformResponse: (response) =>
          transformResponsesResponse(response, {
            publicModel: input.publicModel,
            requestStream: input.request.stream === true,
            upstreamIsSse: true,
            // ChatGPT's Codex subscription backend rejects
            // max_output_tokens. Enforce a conservative local byte budget and
            // let the data plane reserve the discovered model maximum.
            conservativeOutputByteLimit: input.request.max_tokens,
            conservativeBilledInputTokens: input.projectedInputTokens,
            conservativeBilledOutputTokens:
              input.projectedOutputTokens ?? input.request.max_tokens,
          }),
      };
    },

    async prepareResponsesInference(input) {
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const body = {
        ...input.request,
        model: input.upstreamModel,
        // Subscription inference must never persist caller content upstream.
        store: false as const,
        stream: true as const,
      };
      const workspaceId =
        input.identity.externalWorkspaceId ?? input.identity.externalAccountId;
      const headers = codexInferenceHeaders(
        input.secret.accessToken,
        workspaceId,
        sessionId,
        body.model,
        typeof body.service_tier === "string" ? body.service_tier : undefined,
      );

      return {
        url: OPENAI_CODEX_ENDPOINTS.responses,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: input.signal,
        },
        protocol: "responses",
        publicProtocol: "responses",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: (responseHeaders) =>
          parseCodexQuotaHeaders(responseHeaders, deps.now()),
        transformResponse: async (response) => {
          if (!response.body)
            throw new ProviderProtocolError(
              "OpenAI Codex returned an empty Responses stream",
            );

          return new Response(sanitizeCodexResponsesStream(response.body), {
            status: response.status,
            headers: mergeHeadersForPublicResponse(
              response,
              "text/event-stream; charset=utf-8",
            ),
          });
        },
      };
    },

    async prepareSearch(input) {
      const workspaceId =
        input.identity.externalWorkspaceId ?? input.identity.externalAccountId;
      const headers = codexHeaders(
        input.secret.accessToken,
        workspaceId,
        false,
      );

      headers.set("Content-Type", "application/json");

      return {
        url: OPENAI_CODEX_ENDPOINTS.search,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...input.request,
            model: input.upstreamModel,
          }),
          redirect: "error",
          signal: input.signal,
        },
        observeHeaders: (responseHeaders) =>
          parseCodexQuotaHeaders(responseHeaders, deps.now()),
      };
    },

    classifyFailure: classifyHttpFailure,
  };
}

async function exchangeToken(
  deps: AdapterDependencies,
  authorizationCode: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(
    deps.fetch,
    OPENAI_CODEX_ENDPOINTS.token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorizationCode,
        code_verifier: verifier,
        redirect_uri: OPENAI_CODEX_ENDPOINTS.deviceRedirect,
      }),
    },
    15_000,
    signal,
  );

  return assertRecord(
    await expectJson(response, "OpenAI token exchange", 64 * 1024),
    "OpenAI token response",
  );
}

function parseDeviceState(value: OAuthPrivateState): OpenAIDeviceState {
  if (
    value.provider !== "openai" ||
    value.flow !== "device-code" ||
    typeof value.deviceAuthId !== "string" ||
    typeof value.userCode !== "string" ||
    typeof value.intervalMs !== "number" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new ProviderProtocolError("Invalid OpenAI device-login state");
  }

  return value as OpenAIDeviceState;
}

function parseToken(
  payload: Record<string, unknown>,
  now: number,
  fallbackRefresh?: string,
): OAuthSecret {
  const accessToken = nonEmptyString(payload.access_token);
  const refreshToken = nonEmptyString(payload.refresh_token) ?? fallbackRefresh;
  const expiresIn = finiteNumber(payload.expires_in);

  if (
    !accessToken ||
    !refreshToken ||
    expiresIn === undefined ||
    expiresIn <= 0
  ) {
    throw new ProviderProtocolError(
      "OpenAI token response omitted required fields",
    );
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1_000 - TOKEN_SKEW_MS,
    ...(nonEmptyString(payload.id_token)
      ? { idToken: nonEmptyString(payload.id_token) }
      : {}),
  };
}

function extractOpenAIProfile(
  accessToken: string,
  idToken?: string,
): {
  accountId?: string;
  email?: string;
  plan?: string;
} {
  const access = decodeJwtPayload(accessToken);
  const id = idToken ? decodeJwtPayload(idToken) : null;
  const auth = isRecord(access?.[JWT_AUTH_CLAIM])
    ? access[JWT_AUTH_CLAIM]
    : undefined;
  const idAuth = isRecord(id?.[JWT_AUTH_CLAIM])
    ? id?.[JWT_AUTH_CLAIM]
    : undefined;
  const profile = isRecord(access?.[JWT_PROFILE_CLAIM])
    ? access[JWT_PROFILE_CLAIM]
    : undefined;

  return {
    accountId: nonEmptyString(auth?.chatgpt_account_id),
    email: nonEmptyString(profile?.email)?.toLowerCase(),
    plan: nonEmptyString(
      auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type,
    )?.toLowerCase(),
  };
}

export function extractOpenAIIdentity(
  accessToken: string,
  idToken?: string,
): ProviderIdentity {
  const profile = extractOpenAIProfile(accessToken, idToken);

  if (!profile.accountId)
    throw new ProviderProtocolError(
      "OpenAI token did not contain chatgpt_account_id",
    );

  return {
    externalAccountId: profile.accountId,
    externalWorkspaceId: profile.accountId,
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.plan ? { plan: profile.plan } : {}),
  };
}

function codexHeaders(
  accessToken: string,
  accountId: string | undefined,
  stream: boolean,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    version: CLIENT_VERSION,
    "User-Agent": `codex_cli_rs/${CLIENT_VERSION}`,
    Accept: stream ? "text/event-stream" : "application/json",
  });

  if (stream) headers.set("Content-Type", "application/json");
  if (accountId) headers.set("chatgpt-account-id", accountId);

  return headers;
}

function codexInferenceHeaders(
  accessToken: string,
  workspaceId: string | undefined,
  sessionId: string,
  model: string,
  serviceTier?: string,
): Headers {
  const headers = codexHeaders(accessToken, workspaceId, true);

  headers.set("conversation_id", sessionId);
  headers.set("session_id", sessionId);
  headers.set("x-client-request-id", sessionId);
  headers.set("session-id", sessionId);
  headers.set("thread-id", stableUuid(`${sessionId}:thread`));
  headers.set("x-codex-window-id", stableUuid(`${sessionId}:window`));
  headers.set(
    "x-codex-routing-hint",
    serviceTier ? `model=${model};tier=${serviceTier}` : `model=${model}`,
  );

  return headers;
}

export function parseCodexModels(
  payload: unknown,
  etag?: string,
): DiscoveredModel[] {
  if (!isRecord(payload)) return [];
  const entries = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  if (entries.length > MAX_PROVIDER_MODEL_ROWS) return [];

  return entries
    .map((raw): DiscoveredModel | null => {
      if (!isRecord(raw)) return null;
      const upstreamId = providerModelId(raw.slug) ?? providerModelId(raw.id);

      if (!upstreamId) return null;
      const visibility = nonEmptyString(raw.visibility)?.toLowerCase();

      if (visibility === "hide" || visibility === "hidden") return null;
      const modalities: Array<"text" | "image"> = Array.isArray(
        raw.input_modalities,
      )
        ? raw.input_modalities.filter(
            (item): item is "text" | "image" =>
              item === "text" || item === "image",
          )
        : ["text", "image"];
      const presets = Array.isArray(raw.supported_reasoning_levels)
        ? raw.supported_reasoning_levels
        : [];
      const reasoningEfforts = presets.flatMap((item) => {
        const effort = isRecord(item)
          ? nonEmptyString(item.effort)?.toLowerCase()
          : undefined;

        return effort && isModelReasoningEffort(effort) ? [effort] : [];
      });
      const defaultReasoning = nonEmptyString(
        raw.default_reasoning_level,
      )?.toLowerCase();
      const reasoning =
        (defaultReasoning !== undefined && defaultReasoning !== "none") ||
        presets.some((item) => {
          const effort = isRecord(item)
            ? nonEmptyString(item.effort)?.toLowerCase()
            : undefined;

          return effort !== undefined && effort !== "none";
        });
      const contextWindow =
        finiteNumber(raw.max_context_window) ??
        finiteNumber(raw.context_window) ??
        (/^gpt-5\.6(?:-|$)/.test(upstreamId) ? 372_000 : 272_000);

      return {
        upstreamId,
        name: nonEmptyString(raw.display_name) ?? upstreamId,
        contextWindow,
        maxOutputTokens: Math.min(128_000, contextWindow),
        inputModalities: modalities.length > 0 ? modalities : ["text", "image"],
        reasoning,
        reasoningEfforts,
        ...(reasoning ? { thinkingModes: ["adaptive" as const] } : {}),
        ...(etag ? { etag } : {}),
        source: "live",
      };
    })
    .filter((value): value is DiscoveredModel => value !== null);
}

function isModelReasoningEffort(
  value: string,
): value is "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

export function parseCodexCatalog(
  payload: unknown,
): Array<Record<string, unknown>> {
  if (!isRecord(payload)) return [];
  const entries = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  if (entries.length > MAX_PROVIDER_MODEL_ROWS) return [];

  return entries.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const slug = providerModelId(raw.slug) ?? providerModelId(raw.id);

    if (!slug) return [];
    const sanitized = Object.fromEntries(
      CODEX_CATALOG_KEYS.filter((key) => raw[key] !== undefined).map((key) => [
        key,
        raw[key],
      ]),
    );

    return [{ ...sanitized, slug }];
  });
}

export function parseCodexQuota(
  payload: unknown,
  now = Date.now(),
): QuotaSnapshot {
  const data = assertRecord(payload, "OpenAI quota response");
  const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : undefined;
  const windows: QuotaWindow[] = [];

  if (rateLimit) {
    const flags = {
      ...(typeof rateLimit.allowed === "boolean"
        ? { allowed: rateLimit.allowed }
        : {}),
      ...(typeof rateLimit.limit_reached === "boolean"
        ? { limitReached: rateLimit.limit_reached }
        : {}),
    };

    addCodexWindow(
      windows,
      "chat:primary",
      "Primary",
      rateLimit.primary_window,
      now,
      undefined,
      flags,
    );
    addCodexWindow(
      windows,
      "chat:secondary",
      "Secondary",
      rateLimit.secondary_window,
      now,
      undefined,
      flags,
    );
  }
  if (Array.isArray(data.additional_rate_limits)) {
    for (const raw of data.additional_rate_limits) {
      if (!isRecord(raw)) continue;
      const meter =
        nonEmptyString(raw.metered_feature) ??
        nonEmptyString(raw.limit_name) ??
        "extra";
      const nested = isRecord(raw.rate_limit) ? raw.rate_limit : undefined;

      if (!nested) continue;
      addCodexWindow(
        windows,
        `${meter}:primary`,
        `${meter} primary`,
        nested.primary_window,
        now,
        meter,
      );
      addCodexWindow(
        windows,
        `${meter}:secondary`,
        `${meter} secondary`,
        nested.secondary_window,
        now,
        meter,
      );
    }
  }

  return {
    provider: "openai",
    fetchedAt: now,
    windows,
    metadata: {
      source: "poll",
      plan: nonEmptyString(data.plan_type),
      allowed:
        typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined,
      limitReached:
        typeof rateLimit?.limit_reached === "boolean"
          ? rateLimit.limit_reached
          : undefined,
    },
  };
}

function addCodexWindow(
  output: QuotaWindow[],
  id: string,
  label: string,
  raw: unknown,
  now: number,
  scope?: string,
  flags: Pick<QuotaWindow, "allowed" | "limitReached"> = {},
): void {
  if (!isRecord(raw)) return;
  const usedPercent = finiteNumber(raw.used_percent);

  if (usedPercent === undefined) return;
  const used = clampFraction(usedPercent / 100);
  const resetAt = finiteNumber(raw.reset_at);
  const resetAfter = finiteNumber(raw.reset_after_seconds);
  const resetsAt = codexResetAt(resetAt, resetAfter, now);

  output.push({
    id,
    label,
    usedFraction: used,
    remainingFraction: 1 - used,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    status: quotaStatus(used),
    ...flags,
    ...(scope ? { scope } : {}),
  });
}

export function parseCodexQuotaHeaders(
  headers: Headers,
  now = Date.now(),
): QuotaSnapshot | null {
  const windows: QuotaWindow[] = [];

  for (const key of ["primary", "secondary"] as const) {
    const usedPercent = finiteNumber(
      headers.get(`x-codex-${key}-used-percent`),
    );

    if (usedPercent === undefined) continue;
    const used = clampFraction(usedPercent / 100);
    const resetAt = finiteNumber(headers.get(`x-codex-${key}-reset-at`));
    const resetsAt =
      resetAt === undefined ? undefined : unixTimestampMs(resetAt);

    windows.push({
      id: `chat:${key}`,
      label: key === "primary" ? "Primary" : "Secondary",
      usedFraction: used,
      remainingFraction: 1 - used,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      status: quotaStatus(used),
    });
  }

  return windows.length > 0
    ? {
        provider: "openai",
        fetchedAt: now,
        windows,
        metadata: { source: "headers" },
      }
    : null;
}

const unixTimestampMs = (value: number): number =>
  value > 1_000_000_000_000 ? value : value * 1_000;

const codexResetAt = (
  absolute: number | undefined,
  afterSeconds: number | undefined,
  now: number,
): number | undefined => {
  if (absolute !== undefined) return unixTimestampMs(absolute);
  if (afterSeconds !== undefined) return now + afterSeconds * 1_000;

  return undefined;
};

export const openAICodexProviderAdapter = createOpenAICodexProviderAdapter();

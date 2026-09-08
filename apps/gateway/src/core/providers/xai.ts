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

import { webcrypto } from "node:crypto";

import { anthropicToResponses } from "../translate/anthropic-to-responses";
import { normalizeObjectRootToolInputSchema } from "../translate/object-root-tool-schema";
import { transformResponsesResponse } from "../translate/responses-to-anthropic";
import { sanitizeCodexResponsesStream } from "../translate/sanitize-codex-responses";
import {
  prepareXaiCodexCompatibilityRequest,
  restoreXaiCodexCustomToolStream,
} from "../translate/xai-codex-compat";

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
  identityFromJwtSubject,
  isRecord,
  mergeHeadersForPublicResponse,
  nonEmptyString,
  MAX_PROVIDER_MODEL_ROWS,
  providerModelId,
  normalizeSessionId,
  quotaStatus,
  readBoundedJson,
  validateFixedHttpsUrl,
} from "./shared";

export const XAI_ENDPOINTS = {
  discovery: "https://auth.x.ai/.well-known/openid-configuration",
  deviceStart: "https://auth.x.ai/oauth2/device/code",
  token: "https://auth.x.ai/oauth2/token",
  userinfo: "https://auth.x.ai/oauth2/userinfo",
  cliBase: "https://cli-chat-proxy.grok.com/v1",
  responses: "https://cli-chat-proxy.grok.com/v1/responses",
  models: "https://cli-chat-proxy.grok.com/v1/models",
  user: "https://cli-chat-proxy.grok.com/v1/user",
  billing: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
} as const;

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const CLIENT_VERSION = "0.2.101";
const TOKEN_SKEW_MS = 5 * 60_000;
const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const USER_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

interface XaiDeviceState extends OAuthPrivateState {
  provider: "xai";
  flow: "device-code";
  tokenEndpoint: string;
  jwksUri: string;
  deviceCode: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}

const XAI_FALLBACK_MODELS: DiscoveredModel[] = [
  fallback("grok-composer-2.5-fast", "Composer 2.5", 200_000, 30_000, true),
  fallback("grok-build", "Grok Build", 500_000, 30_000, true),
  fallback("grok-4.5", "Grok 4.5", 500_000, 131_072, true),
  fallback("grok-4.3", "Grok 4.3", 1_000_000, 131_072, true),
  fallback(
    "grok-4.20-0309-reasoning",
    "Grok 4.20 Reasoning",
    2_000_000,
    131_072,
    true,
  ),
  fallback(
    "grok-4.20-0309-non-reasoning",
    "Grok 4.20 Non-Reasoning",
    2_000_000,
    131_072,
    false,
  ),
  fallback(
    "grok-4.20-multi-agent-0309",
    "Grok 4.20 Multi-Agent",
    2_000_000,
    131_072,
    true,
  ),
];

export function createXaiProviderAdapter(
  overrides: Partial<AdapterDependencies> = {},
): SubscriptionProviderAdapter {
  const deps = { ...DEFAULT_ADAPTER_DEPENDENCIES, ...overrides };

  return {
    id: "xai",
    codexCatalog: {
      modelIdSource: "public",
      supportsSearchTool: true,
      toolMode: "direct",
      webSearchToolType: null,
    },

    async startLogin(signal) {
      const discovery = await fetchDiscovery(deps, signal);
      const response = await fetchWithTimeout(
        deps.fetch,
        XAI_ENDPOINTS.deviceStart,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "x-grok-client-version": CLIENT_VERSION,
            "x-grok-client-surface": "cli",
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPE,
            referrer: "grok-build",
          }),
        },
        15_000,
        signal,
      );
      const payload = assertRecord(
        await expectJson(response, "xAI device authorization", 64 * 1024),
        "xAI device authorization response",
      );
      const deviceCode = nonEmptyString(payload.device_code);
      const userCode = nonEmptyString(payload.user_code);
      const verificationUri =
        nonEmptyString(payload.verification_uri_complete) ??
        nonEmptyString(payload.verification_uri);
      const expiresInSeconds = finiteNumber(payload.expires_in);
      const intervalSeconds = finiteNumber(payload.interval) ?? 5;

      if (
        !deviceCode ||
        !userCode ||
        !verificationUri ||
        !expiresInSeconds ||
        expiresInSeconds <= 0 ||
        intervalSeconds <= 0
      ) {
        throw new ProviderProtocolError(
          "xAI device authorization omitted required fields",
        );
      }
      const verificationUrl = validateFixedHttpsUrl(
        verificationUri,
        ["auth.x.ai"],
        "xAI verification URL",
      );
      const expiresAt = deps.now() + expiresInSeconds * 1_000;
      const privateState: XaiDeviceState = {
        provider: "xai",
        flow: "device-code",
        tokenEndpoint: discovery.tokenEndpoint,
        jwksUri: discovery.jwksUri,
        deviceCode,
        userCode,
        intervalMs: intervalSeconds * 1_000,
        expiresAt,
      };

      return {
        kind: "device-code",
        verificationUrl,
        userCode,
        intervalMs: privateState.intervalMs,
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
        return { kind: "expired", message: "xAI device code expired" };
      const response = await fetchWithTimeout(
        deps.fetch,
        state.tokenEndpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "x-grok-client-version": CLIENT_VERSION,
            "x-grok-client-surface": "cli",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: state.deviceCode,
            client_id: CLIENT_ID,
          }),
        },
        15_000,
        signal,
      );
      const payload = assertRecord(
        await expectJsonAllowingOAuthError(
          response,
          "xAI device token polling",
        ),
        "xAI device token response",
      );

      if (!response.ok) {
        const error = nonEmptyString(payload.error);

        if (error === "authorization_pending")
          return { kind: "pending", nextPollAt: deps.now() + state.intervalMs };
        if (error === "slow_down") {
          const privateState = {
            ...state,
            intervalMs: state.intervalMs + 5_000,
          };

          return {
            kind: "pending",
            nextPollAt: deps.now() + privateState.intervalMs,
            privateState,
          };
        }
        if (error === "access_denied")
          return { kind: "denied", message: "xAI login was denied" };
        if (error === "expired_token")
          return { kind: "expired", message: "xAI device code expired" };
        throw new ProviderProtocolError(
          `xAI device token polling failed: ${error ?? response.status}`,
          response.status,
        );
      }
      const secret = parseToken(payload, deps.now());

      if (secret.idToken)
        await validateXaiIdToken(deps, secret.idToken, state.jwksUri, signal);
      const identity = await resolveXaiIdentity(
        deps,
        secret.accessToken,
        signal,
      );

      return { kind: "complete", secret, identity };
    },

    async refresh(secret, signal) {
      if (secret.kind === "access-token")
        throw new ProviderProtocolError(
          "Access tokens cannot be refreshed",
          401,
        );
      const discovery = await fetchDiscovery(deps, signal);
      const response = await fetchWithTimeout(
        deps.fetch,
        discovery.tokenEndpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: secret.refreshToken,
          }),
        },
        20_000,
        signal,
      );
      const payload = assertRecord(
        await expectJson(response, "xAI token refresh", 64 * 1024),
        "xAI token response",
      );
      const refreshed = parseToken(payload, deps.now(), secret.refreshToken);

      if (refreshed.idToken)
        await validateXaiIdToken(
          deps,
          refreshed.idToken,
          discovery.jwksUri,
          signal,
        );
      const identity = await fetchXaiUserinfo(
        deps,
        refreshed.accessToken,
        signal,
      ).catch(() => null);

      return {
        secret: refreshed,
        identityPatch: {
          email: identity?.email,
          displayName: identity?.displayName,
        },
      };
    },

    async discover(secret, signal) {
      const response = await fetchWithTimeout(
        deps.fetch,
        XAI_ENDPOINTS.models,
        { method: "GET", headers: xaiProxyHeaders(secret.accessToken) },
        10_000,
        signal,
      );

      if (!response.ok) {
        // The CLI proxy can omit the optional catalog route while inference
        // remains available. Only that explicit non-auth 404 may use the
        // versioned fallback catalog. Auth, throttling, and server failures
        // must retain their status so account refresh can classify them.
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);

          return { models: cloneFallbackModels() };
        }
        const failure = classifyHttpFailure(response.status, response.headers);

        await response.body?.cancel().catch(() => undefined);
        throw new ProviderProtocolError(
          `xAI model discovery failed with HTTP ${failure.status}`,
          failure.status,
          failure.retryAfterMs,
        );
      }
      const payload = await expectJson(
        response,
        "xAI model discovery",
        256 * 1024,
      );

      return { models: mergeXaiModels(payload) };
    },

    async fetchQuota(secret, _identity, signal) {
      const userResponse = await fetchWithTimeout(
        deps.fetch,
        XAI_ENDPOINTS.user,
        { method: "GET", headers: xaiProxyHeaders(secret.accessToken) },
        10_000,
        signal,
      );
      const user = assertRecord(
        await expectJson(userResponse, "xAI user lookup", 64 * 1024),
        "xAI user response",
      );
      const userId = nonEmptyString(user.userId);

      if (!userId || !USER_ID_PATTERN.test(userId))
        throw new ProviderProtocolError(
          "xAI user lookup returned an invalid user id",
        );
      const response = await fetchWithTimeout(
        deps.fetch,
        XAI_ENDPOINTS.billing,
        {
          method: "GET",
          headers: {
            ...xaiProxyHeaders(secret.accessToken),
            "x-userid": userId,
          },
        },
        15_000,
        signal,
      );
      const payload = await expectJson(
        response,
        "xAI billing lookup",
        64 * 1024,
      );

      return parseXaiQuota(payload, deps.now());
    },

    async prepareInference(input) {
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const requestId = deps.randomUUID();
      const body = anthropicToResponses(input.request, {
        model: input.upstreamModel,
        provider: "xai",
        sessionId,
        supportsReasoningEffort: true,
      });

      body.store = false;
      if (body.tools) {
        body.tools = body.tools.map((tool) => ({
          ...tool,
          parameters: normalizeObjectRootToolInputSchema(tool.parameters),
        }));
      }
      const headers = xaiInferenceHeaders(
        input.secret.accessToken,
        input.upstreamModel,
        sessionId,
        requestId,
      );

      return {
        url: XAI_ENDPOINTS.responses,
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
        observeHeaders: () => null,
        transformResponse: (response) =>
          transformResponsesResponse(response, {
            publicModel: input.publicModel,
            requestStream: input.request.stream === true,
            upstreamIsSse: true,
            conservativeBilledInputTokens: input.projectedInputTokens,
            conservativeBilledOutputTokens:
              input.projectedOutputTokens ?? input.request.max_tokens,
          }),
      };
    },

    async prepareResponsesInference(input) {
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const requestId = deps.randomUUID();
      const compatibility = prepareXaiCodexCompatibilityRequest(input.request);
      const body = {
        ...compatibility.request,
        model: input.upstreamModel,
        store: false as const,
        stream: true as const,
      };
      const headers = xaiInferenceHeaders(
        input.secret.accessToken,
        input.upstreamModel,
        sessionId,
        requestId,
      );

      return {
        url: XAI_ENDPOINTS.responses,
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
        observeHeaders: () => null,
        transformResponse: async (response) => {
          if (!response.body)
            throw new ProviderProtocolError(
              "xAI returned an empty Responses stream",
            );

          return new Response(
            sanitizeCodexResponsesStream(
              restoreXaiCodexCustomToolStream(
                response.body,
                compatibility.customTools,
              ),
            ),
            {
              status: response.status,
              headers: mergeHeadersForPublicResponse(
                response,
                "text/event-stream; charset=utf-8",
              ),
            },
          );
        },
      };
    },

    classifyFailure: classifyHttpFailure,
  };
}

function fallback(
  upstreamId: string,
  name: string,
  contextWindow: number,
  maxOutputTokens: number,
  reasoning: boolean,
): DiscoveredModel {
  return {
    upstreamId,
    name,
    contextWindow,
    maxOutputTokens,
    inputModalities: ["text", "image"],
    reasoning,
    ...(reasoning
      ? {
          reasoningEfforts: ["low", "medium", "high"],
          thinkingModes: ["adaptive"],
        }
      : {}),
    source: "fallback",
  };
}

function cloneFallbackModels(): DiscoveredModel[] {
  return XAI_FALLBACK_MODELS.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
  }));
}

async function fetchDiscovery(
  deps: AdapterDependencies,
  signal?: AbortSignal,
): Promise<{ tokenEndpoint: string; jwksUri: string }> {
  const response = await fetchWithTimeout(
    deps.fetch,
    XAI_ENDPOINTS.discovery,
    { method: "GET", headers: { Accept: "application/json" } },
    15_000,
    signal,
  );
  const payload = assertRecord(
    await expectJson(response, "xAI OIDC discovery", 64 * 1024),
    "xAI discovery response",
  );

  if (payload.issuer !== "https://auth.x.ai")
    throw new ProviderProtocolError(
      "xAI discovery returned an unexpected issuer",
    );
  const tokenEndpoint = validateFixedHttpsUrl(
    nonEmptyString(payload.token_endpoint) ?? "",
    ["auth.x.ai"],
    "xAI token endpoint",
  );
  const jwksUri = validateFixedHttpsUrl(
    nonEmptyString(payload.jwks_uri) ?? "",
    ["auth.x.ai"],
    "xAI JWKS endpoint",
  );
  const algorithms = payload.id_token_signing_alg_values_supported;

  if (Array.isArray(algorithms) && !algorithms.includes("ES256")) {
    throw new ProviderProtocolError("xAI discovery does not advertise ES256");
  }

  return { tokenEndpoint, jwksUri };
}

async function expectJsonAllowingOAuthError(
  response: Response,
  label: string,
): Promise<unknown> {
  if (response.ok) return expectJson(response, label, 64 * 1024);
  // OAuth device errors are structured and intentionally interpreted by the state machine.
  try {
    return await readBoundedJson(response, 64 * 1024);
  } catch {
    throw new ProviderProtocolError(
      `${label} failed with HTTP ${response.status}`,
      response.status,
    );
  }
}

function parseDeviceState(value: OAuthPrivateState): XaiDeviceState {
  if (
    value.provider !== "xai" ||
    value.flow !== "device-code" ||
    typeof value.deviceCode !== "string" ||
    typeof value.userCode !== "string" ||
    typeof value.intervalMs !== "number" ||
    typeof value.expiresAt !== "number" ||
    typeof value.tokenEndpoint !== "string" ||
    typeof value.jwksUri !== "string"
  ) {
    throw new ProviderProtocolError("Invalid xAI device-login state");
  }
  validateFixedHttpsUrl(
    value.tokenEndpoint,
    ["auth.x.ai"],
    "xAI token endpoint",
  );
  validateFixedHttpsUrl(value.jwksUri, ["auth.x.ai"], "xAI JWKS endpoint");

  return value as XaiDeviceState;
}

function parseToken(
  payload: Record<string, unknown>,
  now: number,
  refreshFallback?: string,
): OAuthSecret {
  const accessToken = nonEmptyString(payload.access_token);
  const refreshToken = nonEmptyString(payload.refresh_token) ?? refreshFallback;
  const expiresIn = finiteNumber(payload.expires_in);

  if (
    !accessToken ||
    !refreshToken ||
    expiresIn === undefined ||
    expiresIn <= 0
  ) {
    throw new ProviderProtocolError(
      "xAI token response omitted required fields",
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

async function resolveXaiIdentity(
  deps: AdapterDependencies,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProviderIdentity> {
  const userinfo = await fetchXaiUserinfo(deps, accessToken, signal).catch(
    () => null,
  );
  const fallbackIdentity = identityFromJwtSubject(accessToken);
  const identity = userinfo ?? fallbackIdentity;

  if (!identity)
    throw new ProviderProtocolError(
      "xAI login did not return a stable subject",
    );

  return identity;
}

async function fetchXaiUserinfo(
  deps: AdapterDependencies,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProviderIdentity | null> {
  const response = await fetchWithTimeout(
    deps.fetch,
    XAI_ENDPOINTS.userinfo,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    15_000,
    signal,
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);

    return null;
  }
  const data = assertRecord(
    await expectJson(response, "xAI userinfo", 64 * 1024),
    "xAI userinfo response",
  );
  const subject = nonEmptyString(data.sub);

  if (!subject) return null;

  return {
    externalAccountId: subject,
    email: nonEmptyString(data.email)?.toLowerCase(),
    displayName: nonEmptyString(data.name),
  };
}

async function validateXaiIdToken(
  deps: AdapterDependencies,
  token: string,
  jwksUri: string,
  signal?: AbortSignal,
): Promise<void> {
  const parts = token.split(".");

  if (parts.length !== 3)
    throw new ProviderProtocolError("xAI id_token was malformed");
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPayload(token);

  if (
    !header ||
    !claims ||
    header.alg !== "ES256" ||
    typeof header.kid !== "string"
  ) {
    throw new ProviderProtocolError(
      "xAI id_token used an unsupported signature",
    );
  }
  if (claims.iss !== "https://auth.x.ai")
    throw new ProviderProtocolError("xAI id_token issuer did not match");
  const audience = claims.aud;

  if (
    audience !== CLIENT_ID &&
    !(Array.isArray(audience) && audience.includes(CLIENT_ID))
  ) {
    throw new ProviderProtocolError("xAI id_token audience did not match");
  }
  const exp = finiteNumber(claims.exp);

  if (exp === undefined || exp * 1_000 <= deps.now())
    throw new ProviderProtocolError("xAI id_token expired");

  const response = await fetchWithTimeout(
    deps.fetch,
    jwksUri,
    { method: "GET", headers: { Accept: "application/json" } },
    15_000,
    signal,
  );
  const jwks = assertRecord(
    await expectJson(response, "xAI JWKS lookup", 128 * 1024),
    "xAI JWKS response",
  );
  const key = Array.isArray(jwks.keys)
    ? jwks.keys.find(
        (candidate) =>
          isRecord(candidate) &&
          candidate.kid === header.kid &&
          candidate.kty === "EC",
      )
    : undefined;

  if (!isRecord(key))
    throw new ProviderProtocolError("xAI signing key was not found");
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    key as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(parts[2], "base64url"),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );

  if (!valid)
    throw new ProviderProtocolError("xAI id_token signature was invalid");
}

function decodeJwtPart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function platformLabel(): string {
  const os =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform;
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : process.arch;

  return `${os}; ${arch}`;
}

export function xaiProxyHeaders(
  accessToken: string,
  modelId?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": `grok-shell/${CLIENT_VERSION} (${platformLabel()})`,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": CLIENT_VERSION,
    "x-grok-client-mode": "interactive",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    ...(modelId ? { "x-grok-model-override": modelId } : {}),
  };
}

function xaiInferenceHeaders(
  accessToken: string,
  modelId: string,
  sessionId: string,
  requestId: string,
): Headers {
  const headers = new Headers(xaiProxyHeaders(accessToken, modelId));

  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  headers.set("x-grok-conv-id", sessionId);
  headers.set("x-grok-session-id", sessionId);
  headers.set("x-grok-req-id", requestId);

  return headers;
}

export function mergeXaiModels(payload: unknown): DiscoveredModel[] {
  const data =
    isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];

  if (data.length > MAX_PROVIDER_MODEL_ROWS) {
    throw new ProviderProtocolError(
      "xAI model discovery returned too many rows",
    );
  }
  const fallbackById = new Map(
    XAI_FALLBACK_MODELS.map((model) => [model.upstreamId, model]),
  );
  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const id = providerModelId(raw.id);

    if (!id || !id.startsWith("grok") || /imagine|embedding|tts/i.test(id))
      continue;
    const base = fallbackById.get(id);

    seen.add(id);
    result.push({
      upstreamId: id,
      name: base?.name ?? id,
      contextWindow:
        finiteNumber(raw.context_length) ?? base?.contextWindow ?? 1_000_000,
      maxOutputTokens:
        finiteNumber(raw.max_output_tokens) ?? base?.maxOutputTokens ?? 30_000,
      inputModalities: [...(base?.inputModalities ?? ["text", "image"])],
      reasoning: base?.reasoning ?? true,
      reasoningEfforts: [
        ...(base?.reasoningEfforts ?? ["low", "medium", "high"]),
      ],
      thinkingModes: [...(base?.thinkingModes ?? ["adaptive"])],
      source: "live",
    });
  }
  for (const model of XAI_FALLBACK_MODELS) {
    if (!seen.has(model.upstreamId))
      result.push({ ...model, inputModalities: [...model.inputModalities] });
  }

  return result;
}

export function parseXaiQuota(
  payload: unknown,
  now = Date.now(),
): QuotaSnapshot {
  const data = assertRecord(payload, "xAI billing response");
  const config = isRecord(data.config) ? data.config : data;
  const usedPercent = finiteNumber(config.creditUsagePercent);
  const period = isRecord(config.currentPeriod)
    ? config.currentPeriod
    : undefined;
  const resetString =
    nonEmptyString(period?.end) ?? nonEmptyString(config.billingPeriodEnd);
  const resetParsed = resetString ? Date.parse(resetString) : Number.NaN;
  const windows: QuotaWindow[] = [];

  if (usedPercent !== undefined) {
    const used = clampFraction(usedPercent / 100);

    windows.push({
      id: "subscription",
      label: nonEmptyString(period?.type) ?? "Subscription period",
      usedFraction: used,
      remainingFraction: 1 - used,
      ...(Number.isFinite(resetParsed) ? { resetsAt: resetParsed } : {}),
      status: quotaStatus(used),
    });
  }
  if (Array.isArray(config.productUsage)) {
    for (const raw of config.productUsage) {
      if (!isRecord(raw)) continue;
      const product = nonEmptyString(raw.product);
      const percent = finiteNumber(raw.usagePercent);

      if (!product || percent === undefined) continue;
      const used = clampFraction(percent / 100);

      windows.push({
        id: `product:${product.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        label: product,
        usedFraction: used,
        remainingFraction: 1 - used,
        ...(Number.isFinite(resetParsed) ? { resetsAt: resetParsed } : {}),
        status: quotaStatus(used),
        scope: product,
      });
    }
  }

  return {
    provider: "xai",
    fetchedAt: now,
    windows,
    metadata: {
      source: "poll",
      plan: nonEmptyString(data.subscriptionTier),
      onDemandEnabled:
        typeof data.onDemandEnabled === "boolean"
          ? data.onDemandEnabled
          : undefined,
      unifiedBilling:
        typeof config.isUnifiedBillingUser === "boolean"
          ? config.isUnifiedBillingUser
          : undefined,
    },
  };
}

export const xaiProviderAdapter = createXaiProviderAdapter();

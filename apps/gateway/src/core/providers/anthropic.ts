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

import { anthropicSseToCodexResponses } from "../translate/anthropic-to-codex";
import { codexToAnthropic } from "../translate/codex-to-anthropic";
import { getAnthropicAgentSdkTransport } from "./anthropic-agent-sdk";

import {
  CLAUDE_CODE,
  rewriteClaudeCodeCountTokensRequest,
  rewriteClaudeCodeRequest,
  transformClaudeResponse,
} from "./claude-code-wire";
import { generateOAuthState, generatePkce } from "./pkce";
import {
  DEFAULT_ADAPTER_DEPENDENCIES,
  ProviderProtocolError,
  assertRecord,
  clampFraction,
  classifyHttpFailure,
  expectJson,
  fetchWithTimeout,
  finiteNumber,
  isRecord,
  nonEmptyString,
  MAX_PROVIDER_MODEL_ROWS,
  providerModelId,
  quotaStatus,
} from "./shared";

export const ANTHROPIC_ENDPOINTS = {
  authorize: "https://claude.com/cai/oauth/authorize",
  callback: "https://platform.claude.com/oauth/code/callback",
  token: "https://platform.claude.com/v1/oauth/token",
  bootstrap: "https://api.anthropic.com/api/claude_cli/bootstrap",
  usage: "https://api.anthropic.com/api/oauth/usage",
  models: "https://api.anthropic.com/v1/models",
  messages: "https://api.anthropic.com/v1/messages?beta=true",
  countTokens: "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
} as const;

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const LOGIN_TTL_MS = 15 * 60_000;
const TOKEN_SKEW_MS = 5 * 60_000;
const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const REFRESH_SCOPE = OAUTH_SCOPES.filter(
  (scope) => scope !== "org:create_api_key",
).join(" ");

interface AnthropicLoginState extends OAuthPrivateState {
  provider: "anthropic";
  flow: "paste-code";
  verifier: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
}

export function createAnthropicProviderAdapter(
  overrides: Partial<AdapterDependencies> = {},
): SubscriptionProviderAdapter {
  const deps = { ...DEFAULT_ADAPTER_DEPENDENCIES, ...overrides };

  return {
    id: "anthropic",
    codexCatalog: {
      modelIdSource: "public",
      supportsSearchTool: true,
      toolMode: "direct",
      webSearchToolType: null,
    },

    async startLogin(signal) {
      if (signal?.aborted) throw signal.reason;
      const pkce = generatePkce();
      const state = generateOAuthState();
      const expiresAt = deps.now() + LOGIN_TTL_MS;
      const url = new URL(ANTHROPIC_ENDPOINTS.authorize);

      url.searchParams.set("code", "true");
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", ANTHROPIC_ENDPOINTS.callback);
      url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      const privateState: AnthropicLoginState = {
        provider: "anthropic",
        flow: "paste-code",
        verifier: pkce.verifier,
        state,
        redirectUri: ANTHROPIC_ENDPOINTS.callback,
        expiresAt,
      };

      return {
        kind: "paste-code",
        authorizationUrl: url.toString(),
        expiresAt,
        privateState,
      };
    },

    async continueLogin(rawState, pastedInput, signal): Promise<LoginProgress> {
      const state = parseLoginState(rawState);

      if (state.expiresAt <= deps.now())
        return { kind: "expired", message: "Claude login expired" };
      if (!pastedInput?.trim())
        throw new ProviderProtocolError(
          "Claude authorization code is required",
        );
      const callback = parseCallback(pastedInput, state.state);

      if (!callback || callback.state !== state.state) {
        throw new ProviderProtocolError("Claude OAuth state did not match");
      }
      const payload = await tokenRequest(
        deps,
        {
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: callback.code,
          state: callback.state,
          redirect_uri: state.redirectUri,
          code_verifier: state.verifier,
        },
        signal,
      );
      const secret = parseToken(payload, deps.now());
      const identity = await resolveAnthropicIdentity(
        deps,
        secret.accessToken,
        payload,
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
      const payload = await tokenRequest(
        deps,
        {
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: secret.refreshToken,
          scope: REFRESH_SCOPE,
        },
        signal,
      );
      const refreshed = parseToken(payload, deps.now(), secret.refreshToken);
      const account = isRecord(payload.account) ? payload.account : undefined;

      return {
        secret: refreshed,
        identityPatch: {
          email: nonEmptyString(account?.email_address)?.toLowerCase(),
        },
      };
    },

    async discover(secret, signal) {
      return {
        models: await fetchAnthropicModels(deps, secret.accessToken, signal),
      };
    },

    async fetchQuota(secret, _identity, signal) {
      const response = await fetchWithTimeout(
        deps.fetch,
        ANTHROPIC_ENDPOINTS.usage,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${secret.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": `claude-code/${CLAUDE_CODE.version}`,
          },
        },
        15_000,
        signal,
      );
      const payload = await expectJson(
        response,
        "Claude quota lookup",
        128 * 1024,
      );

      return parseAnthropicQuota(payload, deps.now());
    },

    async prepareQuotaProbe(input) {
      const prepared = await this.prepareInference(input);
      // The non-beta route preserves quota headers on scoped exhaustion.
      prepared.url = "https://api.anthropic.com/v1/messages";
      // Measured Claude Code 2.1.260 token-only quota profile. Inference beta
      // combinations can reject newer scoped models before returning quota.
      prepared.init.headers = {
        Authorization: `Bearer ${input.secret.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.260 (external, cli)",
      };
      prepared.init.body = JSON.stringify({
        model: input.upstreamModel,
        max_tokens: 1,
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ],
        messages: [{ role: "user", content: "quota" }],
      });
      return prepared;
    },

    async prepareInference(input) {
      const requestId = deps.randomUUID();
      const rewritten = rewriteClaudeCodeRequest({
        request: input.request,
        upstreamModel: input.upstreamModel,
        identity: input.identity,
        accessToken: input.secret.accessToken,
        sessionId: input.sessionId,
        requestId,
      });

      return {
        url: ANTHROPIC_ENDPOINTS.messages,
        init: {
          method: "POST",
          headers: rewritten.headers,
          body: rewritten.body,
          redirect: "error",
          signal: input.signal,
        },
        protocol: "anthropic",
        publicProtocol: "anthropic",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: (headers) =>
          parseAnthropicQuotaHeaders(headers, deps.now()),
        transformResponse: (response) =>
          transformClaudeResponse(
            response,
            input.request.stream === true,
            rewritten.toolNames,
          ),
      };
    },

    async prepareResponsesInference(input) {
      const converted = codexToAnthropic(input.request, {
        model: input.upstreamModel,
        maxOutputTokens: Math.max(1, input.projectedOutputTokens ?? 64_000),
      });
      const requestId = deps.randomUUID();
      const rewritten = rewriteClaudeCodeRequest({
        request: converted.request,
        upstreamModel: input.upstreamModel,
        identity: input.identity,
        accessToken: input.secret.accessToken,
        sessionId: input.sessionId,
        requestId,
      });

      return {
        url: ANTHROPIC_ENDPOINTS.messages,
        init: {
          method: "POST",
          headers: rewritten.headers,
          body: rewritten.body,
          redirect: "error",
          signal: input.signal,
        },
        protocol: "anthropic",
        publicProtocol: "responses",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: (headers) =>
          parseAnthropicQuotaHeaders(headers, deps.now()),
        transformResponse: async (response) => {
          const anthropic = await transformClaudeResponse(
            response,
            true,
            rewritten.toolNames,
          );

          if (!anthropic.body)
            throw new ProviderProtocolError(
              "Anthropic returned an empty translated stream",
            );

          return new Response(
            anthropicSseToCodexResponses(anthropic.body, {
              publicModel: input.publicModel,
              toolIdentities: converted.toolIdentities,
            }),
            { status: anthropic.status, headers: anthropic.headers },
          );
        },
      };
    },

    async prepareExternalInference(input) {
      return getAnthropicAgentSdkTransport().prepareInference(input);
    },

    async prepareExternalResponsesInference(input) {
      return getAnthropicAgentSdkTransport().prepareResponsesInference(input);
    },

    async discoverExternal(transport, signal) {
      return getAnthropicAgentSdkTransport().discover(transport, signal);
    },

    async fetchExternalQuota(transport, signal) {
      return getAnthropicAgentSdkTransport().fetchQuota(transport, signal);
    },

    async listExternalProfiles(transportId, signal) {
      if (transportId !== "agent-sdk") {
        throw new ProviderProtocolError(
          "Anthropic external transport is unsupported",
          400,
        );
      }

      return getAnthropicAgentSdkTransport().listProfiles(signal);
    },

    async prepareTokenCount(input) {
      const requestId = deps.randomUUID();
      const rewritten = rewriteClaudeCodeCountTokensRequest({
        request: input.request,
        upstreamModel: input.upstreamModel,
        identity: input.identity,
        accessToken: input.secret.accessToken,
        sessionId: input.sessionId,
        requestId,
      });

      return {
        url: ANTHROPIC_ENDPOINTS.countTokens,
        init: {
          method: "POST",
          headers: rewritten.headers,
          body: rewritten.body,
          redirect: "error",
          signal: input.signal,
        },
        protocol: "anthropic",
        publicProtocol: "anthropic",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: (headers) =>
          parseAnthropicQuotaHeaders(headers, deps.now()),
        transformResponse: async (response) => response,
      };
    },

    classifyFailure: classifyHttpFailure,
  };
}

function parseLoginState(value: OAuthPrivateState): AnthropicLoginState {
  if (
    value.provider !== "anthropic" ||
    value.flow !== "paste-code" ||
    typeof value.verifier !== "string" ||
    typeof value.state !== "string" ||
    value.redirectUri !== ANTHROPIC_ENDPOINTS.callback ||
    typeof value.expiresAt !== "number"
  ) {
    throw new ProviderProtocolError("Invalid Claude login state");
  }

  return value as AnthropicLoginState;
}

function parseCallback(
  input: string,
  expectedState: string,
): { code: string; state: string } | null {
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (code && state) return { code, state };
  } catch {
    // Manual code formats are parsed below.
  }
  const hash = trimmed.indexOf("#");

  if (hash > 0 && hash < trimmed.length - 1) {
    return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
  }
  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");

  if (code && state) return { code, state };

  // Claude's manual callback page displays a copyable authentication code.
  // The OAuth attempt already retains the matching state and PKCE verifier,
  // so users should not need to reconstruct or copy the browser URL.
  return /^[A-Za-z0-9._~-]{8,4096}$/u.test(trimmed)
    ? { code: trimmed, state: expectedState }
    : null;
}

async function tokenRequest(
  deps: AdapterDependencies,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(
    deps.fetch,
    ANTHROPIC_ENDPOINTS.token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "axios/1.15.2",
      },
      body: JSON.stringify(body),
    },
    30_000,
    signal,
  );

  return assertRecord(
    await expectJson(response, "Claude OAuth token request", 64 * 1024),
    "Claude token response",
  );
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
      "Claude token response omitted required fields",
    );
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1_000 - TOKEN_SKEW_MS,
  };
}

async function resolveAnthropicIdentity(
  deps: AdapterDependencies,
  accessToken: string,
  tokenPayload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ProviderIdentity> {
  const account = isRecord(tokenPayload.account)
    ? tokenPayload.account
    : undefined;
  const organization = isRecord(tokenPayload.organization)
    ? tokenPayload.organization
    : undefined;
  let accountId = nonEmptyString(account?.uuid);
  let email = nonEmptyString(account?.email_address)?.toLowerCase();
  let workspaceId = nonEmptyString(organization?.uuid);
  let workspaceName = nonEmptyString(organization?.name);

  if (!accountId || !email || !workspaceId) {
    const bootstrap = await fetchBootstrap(
      deps,
      accessToken,
      "default",
      signal,
    );
    const oauthAccount = isRecord(bootstrap.oauth_account)
      ? bootstrap.oauth_account
      : undefined;

    accountId ??= nonEmptyString(oauthAccount?.account_uuid);
    email ??= nonEmptyString(oauthAccount?.account_email)?.toLowerCase();
    workspaceId ??= nonEmptyString(oauthAccount?.organization_uuid);
    workspaceName ??= nonEmptyString(oauthAccount?.organization_name);
  }
  if (!accountId)
    throw new ProviderProtocolError(
      "Claude login did not return a stable account identity",
    );

  return {
    externalAccountId: accountId,
    ...(workspaceId ? { externalWorkspaceId: workspaceId } : {}),
    ...(email ? { email } : {}),
    ...(workspaceName ? { displayName: workspaceName } : {}),
  };
}

export function parseAnthropicModels(payload: unknown): DiscoveredModel[] {
  const root = assertRecord(payload, "Claude models response");
  const entries = Array.isArray(root.data) ? root.data : [];

  if (entries.length > MAX_PROVIDER_MODEL_ROWS) {
    throw new ProviderProtocolError(
      "Claude model discovery returned too many rows",
    );
  }
  const newestByFamily = new Map<
    string,
    { model: DiscoveredModel; createdAt: number }
  >();

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const upstreamId = providerModelId(raw.id);
    const name = nonEmptyString(raw.display_name);
    const family = upstreamId?.match(/^claude-([a-z0-9]+)-/i)?.[1];

    if (!upstreamId || !name || !family) continue;
    const capabilities = isRecord(raw.capabilities)
      ? raw.capabilities
      : undefined;
    const thinking = isRecord(capabilities?.thinking)
      ? capabilities.thinking
      : undefined;
    const effort = isRecord(capabilities?.effort)
      ? capabilities.effort
      : undefined;
    const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;
    const reasoningEfforts = effortValues.filter((value) => {
      const capability = isRecord(effort?.[value]) ? effort[value] : undefined;

      return capability?.supported === true;
    });
    const thinkingTypes = isRecord(thinking?.types)
      ? thinking.types
      : undefined;
    const thinkingModes = (["adaptive", "enabled"] as const).filter((value) => {
      const capability = isRecord(thinkingTypes?.[value])
        ? thinkingTypes[value]
        : undefined;

      return capability?.supported === true;
    });
    const contextManagement = isRecord(capabilities?.context_management)
      ? capabilities.context_management
      : undefined;
    const clearThinking = isRecord(contextManagement?.clear_thinking_20251015)
      ? contextManagement.clear_thinking_20251015
      : undefined;
    const compact = isRecord(contextManagement?.compact_20260112)
      ? contextManagement.compact_20260112
      : undefined;
    const image = isRecord(capabilities?.image_input)
      ? capabilities.image_input
      : undefined;
    const contextWindow = finiteNumber(raw.max_input_tokens);
    const maxOutputTokens = finiteNumber(raw.max_tokens);
    const inputModalities: Array<"text" | "image"> =
      image?.supported === true ? ["text", "image"] : ["text"];
    const createdAt =
      typeof raw.created_at === "string"
        ? Date.parse(raw.created_at)
        : Number.NEGATIVE_INFINITY;
    const candidate = {
      model: {
        upstreamId,
        name,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        inputModalities,
        reasoning: thinking?.supported === true || effort?.supported === true,
        reasoningEfforts,
        thinkingModes,
        ...(contextManagement?.supported === true
          ? {
              contextManagement: {
                clearThinking: clearThinking?.supported === true,
                compact: compact?.supported === true,
              },
            }
          : {}),
        source: "live" as const,
      },
      createdAt: Number.isFinite(createdAt)
        ? createdAt
        : Number.NEGATIVE_INFINITY,
    };
    const current = newestByFamily.get(family.toLowerCase());

    if (!current || candidate.createdAt > current.createdAt) {
      newestByFamily.set(family.toLowerCase(), candidate);
    }
  }

  return [...newestByFamily.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(({ model }) => ({
      ...model,
      inputModalities: [...model.inputModalities],
    }));
}

async function fetchAnthropicModels(
  deps: AdapterDependencies,
  accessToken: string,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const url = new URL(ANTHROPIC_ENDPOINTS.models);

  url.searchParams.set("limit", "100");
  const response = await fetchWithTimeout(
    deps.fetch,
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${CLAUDE_CODE.version}`,
      },
    },
    30_000,
    signal,
  );
  const models = parseAnthropicModels(
    await expectJson(response, "Claude model discovery", 512 * 1024),
  );

  if (models.length === 0)
    throw new ProviderProtocolError(
      "Claude model discovery returned no models",
    );

  return models;
}

async function fetchBootstrap(
  deps: AdapterDependencies,
  accessToken: string,
  model: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(ANTHROPIC_ENDPOINTS.bootstrap);

  url.searchParams.set("entrypoint", "cli");
  url.searchParams.set("model", model);
  const response = await fetchWithTimeout(
    deps.fetch,
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `claude-code/${CLAUDE_CODE.version}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    30_000,
    signal,
  );

  return assertRecord(
    await expectJson(response, "Claude account bootstrap", 128 * 1024),
    "Claude bootstrap response",
  );
}

export function parseAnthropicQuota(
  payload: unknown,
  now = Date.now(),
): QuotaSnapshot {
  const data = assertRecord(payload, "Claude quota response");
  const windows: QuotaWindow[] = [];

  addUsageWindow(windows, "five_hour", "5 hours", data.five_hour, now);
  addUsageWindow(windows, "seven_day", "7 days", data.seven_day, now);
  if (Array.isArray(data.limits)) {
    for (const rawLimit of data.limits) {
      if (!isRecord(rawLimit) || rawLimit.kind !== "weekly_scoped") continue;
      const percent = finiteNumber(rawLimit.percent);
      const scope = isRecord(rawLimit.scope) ? rawLimit.scope : undefined;
      const model = isRecord(scope?.model) ? scope.model : undefined;
      const modelId =
        nonEmptyString(model?.id) ?? nonEmptyString(model?.display_name);

      if (percent === undefined || !modelId) continue;
      const used = clampFraction(percent / 100);

      windows.push({
        id: `weekly:${modelId}`,
        label: `${nonEmptyString(model?.display_name) ?? modelId} weekly`,
        usedFraction: used,
        remainingFraction: 1 - used,
        resetsAt: parseReset(rawLimit.resets_at),
        status: quotaStatus(used),
        scope: modelId,
      });
    }
  }
  const extra = isRecord(data.extra_usage) ? data.extra_usage : undefined;
  const extraUsagePercent = finiteNumber(extra?.utilization);

  return {
    provider: "anthropic",
    fetchedAt: now,
    windows,
    metadata: {
      source: "poll",
      ...(extra?.is_enabled === true ? { extraUsageEnabled: true } : {}),
      ...(extraUsagePercent !== undefined ? { extraUsagePercent } : {}),
    },
  };
}

function addUsageWindow(
  windows: QuotaWindow[],
  id: string,
  label: string,
  value: unknown,
  _now: number,
): void {
  if (!isRecord(value)) return;
  const percent = finiteNumber(value.utilization);

  if (percent === undefined) return;
  const used = clampFraction(percent / 100);

  windows.push({
    id,
    label,
    usedFraction: used,
    remainingFraction: 1 - used,
    resetsAt: parseReset(value.resets_at),
    status: quotaStatus(used),
  });
}

function parseReset(value: unknown): number | undefined {
  const raw = nonEmptyString(value);

  if (!raw) return undefined;
  const parsed = Date.parse(raw);

  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseAnthropicQuotaHeaders(
  headers: Headers,
  now = Date.now(),
): QuotaSnapshot | null {
  const windows: QuotaWindow[] = [];

  for (const [suffix, label] of [
    ["5h", "5 hours"],
    ["7d", "7 days"],
    ["7d_oi", "Scoped weekly usage"],
  ] as const) {
    const utilization = finiteNumber(
      headers.get(`anthropic-ratelimit-unified-${suffix}-utilization`),
    );

    const rejected =
      headers.get(`anthropic-ratelimit-unified-${suffix}-status`) ===
      "rejected";
    if (utilization === undefined && !rejected) continue;
    const used = clampFraction(utilization ?? 1);
    const resetSeconds = finiteNumber(
      headers.get(`anthropic-ratelimit-unified-${suffix}-reset`),
    );

    windows.push({
      id:
        suffix === "5h"
          ? "five_hour"
          : suffix === "7d"
            ? "seven_day"
            : "seven_day_overage_included",
      ...(suffix === "7d_oi"
        ? { scope: "requested-model", meterKey: "seven_day_overage_included" }
        : {}),
      allowed: !rejected,
      label,
      usedFraction: used,
      remainingFraction: 1 - used,
      ...(resetSeconds !== undefined ? { resetsAt: resetSeconds * 1_000 } : {}),
      status: quotaStatus(used),
    });
  }
  if (windows.length === 0) return null;

  return {
    provider: "anthropic",
    fetchedAt: now,
    windows,
    metadata: {
      source: "headers",
      organizationId: headers.get("anthropic-organization-id"),
      representativeClaim: headers.get(
        "anthropic-ratelimit-unified-representative-claim",
      ),
      fallbackAvailable:
        headers.get("anthropic-ratelimit-unified-fallback") === "available",
    },
  };
}

export const anthropicProviderAdapter = createAnthropicProviderAdapter();

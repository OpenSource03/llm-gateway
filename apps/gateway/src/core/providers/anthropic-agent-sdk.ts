import type {
  AdapterDependencies,
  DiscoveredModel,
  ExternalTransportReference,
  ExternalTransportProfile,
  PrepareExternalInferenceInput,
  PrepareExternalResponsesInferenceInput,
  PreparedUpstream,
  ProviderDiscovery,
  ProviderFailure,
  QuotaSnapshot,
  QuotaWindow,
} from "./types";

import { getEnv } from "../../config/env";
import { anthropicSseToCodexResponses } from "../translate/anthropic-to-codex";
import { codexToAnthropic } from "../translate/codex-to-anthropic";
import { transformClaudeResponse } from "./claude-code-wire";
import {
  DEFAULT_ADAPTER_DEPENDENCIES,
  MAX_PROVIDER_MODEL_ROWS,
  ProviderProtocolError,
  assertRecord,
  clampFraction,
  expectJson,
  fetchWithTimeout,
  finiteNumber,
  isRecord,
  nonEmptyString,
  parseRetryAfter,
  providerModelId,
  quotaStatus,
} from "./shared";

const TRANSPORT_ID = "agent-sdk";
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_RESPONSE_LIMIT = 2 * 1024 * 1024;

export interface AnthropicAgentSdkConfig {
  baseUrl: string;
  apiKey: string;
}

const configuredTransport = (): AnthropicAgentSdkConfig => {
  const env = getEnv();

  if (
    !env.GATEWAY_ANTHROPIC_AGENT_SDK_URL ||
    !env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY
  ) {
    throw new ProviderProtocolError(
      "Anthropic Agent SDK transport is not configured",
      503,
    );
  }

  return {
    baseUrl: env.GATEWAY_ANTHROPIC_AGENT_SDK_URL,
    apiKey: env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY,
  };
};

const profileId = (transport: ExternalTransportReference): string => {
  if (transport.id !== TRANSPORT_ID || !PROFILE_ID.test(transport.profileId)) {
    throw new ProviderProtocolError(
      "Anthropic Agent SDK profile is invalid",
      503,
    );
  }

  return transport.profileId;
};

const endpoint = (config: AnthropicAgentSdkConfig, path: string): URL =>
  new URL(path.replace(/^\//, ""), `${config.baseUrl.replace(/\/$/, "")}/`);

const requestHeaders = (
  config: AnthropicAgentSdkConfig,
  transport: ExternalTransportReference,
  agent?: "passthrough" | "codex",
): Headers => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "x-meridian-profile": profileId(transport),
  });

  if (agent) headers.set("x-meridian-agent", agent);

  return headers;
};

const serviceHeaders = (config: AnthropicAgentSdkConfig): Headers =>
  new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  });

export const classifyAgentSdkFailure = (
  status: number,
  headers: Headers,
): ProviderFailure => {
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers);

    return {
      kind: "quota",
      retryable: true,
      reauthenticate: false,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      kind: "invalid-request",
      retryable: false,
      reauthenticate: false,
      status,
    };
  }

  return {
    kind:
      status >= 500 || status === 401 || status === 403
        ? "transient"
        : "unknown",
    retryable: status >= 500 || status === 401 || status === 403,
    reauthenticate: false,
    status,
  };
};

const capabilitySupported = (
  capabilities: Record<string, unknown> | undefined,
  name: string,
): boolean => {
  const value = capabilities?.[name];

  return value === true || (isRecord(value) && value.supported === true);
};

export const parseAgentSdkModels = (payload: unknown): ProviderDiscovery => {
  const root = assertRecord(payload, "Agent SDK model catalog");
  const entries = Array.isArray(root.data) ? root.data : [];

  if (entries.length > MAX_PROVIDER_MODEL_ROWS) {
    throw new ProviderProtocolError(
      "Agent SDK model catalog returned too many rows",
    );
  }
  const models: DiscoveredModel[] = [];
  const nativeEntries: Array<Record<string, unknown>> = [];
  const seenFamilies = new Set<string>();

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const upstreamId = providerModelId(raw.id);
    const displayName = nonEmptyString(raw.display_name) ?? upstreamId;
    const family = upstreamId?.match(/^claude-([a-z0-9]+)-/i)?.[1];

    if (!upstreamId || !displayName || !family || seenFamilies.has(family)) {
      continue;
    }
    const capabilities = isRecord(raw.capabilities)
      ? raw.capabilities
      : undefined;
    const effort = isRecord(capabilities?.effort)
      ? capabilities.effort
      : undefined;
    const thinking = isRecord(capabilities?.thinking)
      ? capabilities.thinking
      : undefined;
    const thinkingTypes = isRecord(thinking?.types)
      ? thinking.types
      : undefined;
    const contextManagement = isRecord(capabilities?.context_management)
      ? capabilities.context_management
      : undefined;
    const reasoningEfforts = (
      ["low", "medium", "high", "xhigh", "max"] as const
    ).filter((value) => capabilitySupported(effort, value));
    const thinkingModes = (["adaptive", "enabled"] as const).filter((value) =>
      capabilitySupported(thinkingTypes, value),
    );
    const contextWindow = finiteNumber(raw.context_window);
    const inputModalities: Array<"text" | "image"> = capabilitySupported(
      capabilities,
      "image_input",
    )
      ? ["text", "image"]
      : ["text"];

    seenFamilies.add(family);
    models.push({
      upstreamId,
      name: displayName,
      ...(contextWindow ? { contextWindow } : {}),
      inputModalities,
      reasoning:
        capabilitySupported(capabilities, "thinking") ||
        capabilitySupported(capabilities, "effort"),
      reasoningEfforts,
      thinkingModes,
      ...(capabilitySupported(capabilities, "context_management")
        ? {
            contextManagement: {
              clearThinking: capabilitySupported(
                contextManagement,
                "clear_thinking_20251015",
              ),
              compact: capabilitySupported(
                contextManagement,
                "compact_20260112",
              ),
            },
          }
        : {}),
      source: "live",
    });
    nativeEntries.push({
      id: upstreamId,
      display_name: displayName,
      context_window: contextWindow ?? null,
    });
  }

  if (models.length === 0) {
    throw new ProviderProtocolError(
      "Agent SDK model catalog returned no Claude models",
    );
  }

  return { models, nativeCatalog: { entries: nativeEntries } };
};

export const parseAgentSdkQuota = (
  payload: unknown,
  requestedProfile: string,
  now = Date.now(),
): QuotaSnapshot => {
  const root = assertRecord(payload, "Agent SDK quota response");
  const profiles = Array.isArray(root.profiles) ? root.profiles : [];
  const profile = profiles.find(
    (value) => isRecord(value) && value.id === requestedProfile,
  );

  if (!isRecord(profile)) {
    throw new ProviderProtocolError(
      "Agent SDK quota response omitted the requested profile",
      503,
    );
  }
  if (profile.error) {
    throw new ProviderProtocolError(
      "Agent SDK profile quota is unavailable",
      profile.error === "no_token" ? 401 : 503,
    );
  }
  const rawWindows = Array.isArray(profile.windows) ? profile.windows : [];
  const windows: QuotaWindow[] = [];

  for (const raw of rawWindows) {
    if (!isRecord(raw)) continue;
    const id = nonEmptyString(raw.type);
    const utilization = finiteNumber(raw.utilization);
    const resetsAt = finiteNumber(raw.resetsAt);

    if (!id || id.length > 128 || utilization === undefined) continue;
    const used = clampFraction(utilization);

    windows.push({
      id,
      label: id.replaceAll("_", " "),
      usedFraction: used,
      remainingFraction: 1 - used,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      status: quotaStatus(used),
    });
  }

  return {
    provider: "anthropic",
    fetchedAt:
      finiteNumber(profile.fetchedAt) ?? finiteNumber(root.asOf) ?? now,
    windows,
    metadata: { source: "agent-sdk", profile: requestedProfile },
  };
};

export const parseAgentSdkProfiles = (
  payload: unknown,
): ExternalTransportProfile[] => {
  const root = assertRecord(payload, "Agent SDK profiles response");
  const profiles = Array.isArray(root.profiles) ? root.profiles : [];

  if (profiles.length > 100) {
    throw new ProviderProtocolError("Agent SDK returned too many profiles");
  }

  return profiles.flatMap((raw): ExternalTransportProfile[] => {
    if (!isRecord(raw)) return [];
    const id = nonEmptyString(raw.id);

    if (!id || !PROFILE_ID.test(id)) return [];
    const email = nonEmptyString(raw.email)?.toLowerCase();
    const displayName = nonEmptyString(raw.name);
    const plan = nonEmptyString(raw.subscriptionType);

    return [
      {
        id,
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
        ...(plan ? { plan } : {}),
        authenticated: raw.loggedIn === true,
      },
    ];
  });
};

export const parseAgentSdkDefaultProfile = (
  payload: unknown,
): ExternalTransportProfile => {
  const root = assertRecord(payload, "Agent SDK health response");
  const auth = isRecord(root.auth) ? root.auth : undefined;
  const email = nonEmptyString(auth?.email)?.toLowerCase();
  const plan = nonEmptyString(auth?.subscriptionType);

  return {
    id: "default",
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    authenticated: auth?.loggedIn === true,
  };
};

export class AnthropicAgentSdkTransport {
  readonly #config: AnthropicAgentSdkConfig;
  readonly #deps: AdapterDependencies;

  constructor(
    config: AnthropicAgentSdkConfig,
    dependencies: Partial<AdapterDependencies> = {},
  ) {
    this.#config = config;
    this.#deps = { ...DEFAULT_ADAPTER_DEPENDENCIES, ...dependencies };
  }

  async listProfiles(
    signal?: AbortSignal,
  ): Promise<ExternalTransportProfile[]> {
    const response = await fetchWithTimeout(
      this.#deps.fetch,
      endpoint(this.#config, "/profiles/list"),
      { method: "GET", headers: serviceHeaders(this.#config) },
      30_000,
      signal,
    );

    const profiles = parseAgentSdkProfiles(
      await expectJson(
        response,
        "Agent SDK profile discovery",
        CONTROL_RESPONSE_LIMIT,
      ),
    );

    if (profiles.length > 0) return profiles;
    const health = await fetchWithTimeout(
      this.#deps.fetch,
      endpoint(this.#config, "/health"),
      { method: "GET", headers: serviceHeaders(this.#config) },
      15_000,
      signal,
    );

    return [
      parseAgentSdkDefaultProfile(
        await expectJson(
          health,
          "Agent SDK default profile discovery",
          CONTROL_RESPONSE_LIMIT,
        ),
      ),
    ];
  }

  async discover(
    transport: ExternalTransportReference,
    signal?: AbortSignal,
  ): Promise<ProviderDiscovery> {
    const response = await fetchWithTimeout(
      this.#deps.fetch,
      endpoint(this.#config, "/v1/models"),
      { method: "GET", headers: requestHeaders(this.#config, transport) },
      30_000,
      signal,
    );

    return parseAgentSdkModels(
      await expectJson(
        response,
        "Agent SDK model discovery",
        CONTROL_RESPONSE_LIMIT,
      ),
    );
  }

  async fetchQuota(
    transport: ExternalTransportReference,
    signal?: AbortSignal,
  ): Promise<QuotaSnapshot> {
    const response = await fetchWithTimeout(
      this.#deps.fetch,
      endpoint(this.#config, "/v1/usage/quota/all"),
      { method: "GET", headers: requestHeaders(this.#config, transport) },
      30_000,
      signal,
    );

    return parseAgentSdkQuota(
      await expectJson(
        response,
        "Agent SDK quota discovery",
        CONTROL_RESPONSE_LIMIT,
      ),
      profileId(transport),
      this.#deps.now(),
    );
  }

  async prepareInference(
    input: PrepareExternalInferenceInput,
  ): Promise<PreparedUpstream> {
    const headers = requestHeaders(
      this.#config,
      input.transport,
      "passthrough",
    );

    headers.set("anthropic-version", "2023-06-01");
    if (input.sessionId) {
      headers.set("x-litellm-session-id", input.sessionId);
    }

    return {
      url: endpoint(this.#config, "/v1/messages").toString(),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input.request, model: input.upstreamModel }),
        signal: input.signal,
        redirect: "error",
      },
      protocol: "anthropic",
      publicProtocol: "anthropic",
      publicModel: input.publicModel,
      upstreamModel: input.upstreamModel,
      observeHeaders: () => null,
      transformResponse: (response) =>
        transformClaudeResponse(
          response,
          input.request.stream === true,
          new Map(),
        ),
      classifyFailure: classifyAgentSdkFailure,
    };
  }

  async prepareResponsesInference(
    input: PrepareExternalResponsesInferenceInput,
  ): Promise<PreparedUpstream> {
    const headers = requestHeaders(this.#config, input.transport, "codex");
    const converted = codexToAnthropic(input.request, {
      model: input.upstreamModel,
      maxOutputTokens: Math.max(1, input.projectedOutputTokens ?? 64_000),
    });
    const sessionId = input.request.prompt_cache_key ?? input.sessionId;

    headers.set("anthropic-version", "2023-06-01");
    if (sessionId) headers.set("x-codex-session", sessionId);

    return {
      url: endpoint(this.#config, "/v1/messages").toString(),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(converted.request),
        signal: input.signal,
        redirect: "error",
      },
      protocol: "anthropic",
      publicProtocol: "responses",
      publicModel: input.publicModel,
      upstreamModel: input.upstreamModel,
      observeHeaders: () => null,
      transformResponse: async (response) => {
        const anthropic = await transformClaudeResponse(
          response,
          true,
          new Map(),
        );

        if (!anthropic.body) {
          throw new ProviderProtocolError(
            "Agent SDK returned an empty Anthropic stream",
          );
        }

        return new Response(
          anthropicSseToCodexResponses(anthropic.body, {
            publicModel: input.publicModel,
            toolIdentities: converted.toolIdentities,
          }),
          { status: anthropic.status, headers: anthropic.headers },
        );
      },
      classifyFailure: classifyAgentSdkFailure,
    };
  }
}

let cachedTransport: AnthropicAgentSdkTransport | null = null;

export const getAnthropicAgentSdkTransport = (): AnthropicAgentSdkTransport =>
  (cachedTransport ??= new AnthropicAgentSdkTransport(configuredTransport()));

export const resetAnthropicAgentSdkTransportForTests = (): void => {
  cachedTransport = null;
};

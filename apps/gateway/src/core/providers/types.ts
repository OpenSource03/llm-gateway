import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { CodexResponsesRequest } from "../wire/codex-responses";
import type { CodexSearchRequest } from "../wire/codex-search";

/** Stable, lowercase adapter identifier persisted independently of code enums. */
export type ProviderId = string;
export type UpstreamProtocol = "anthropic" | "responses";

/** Plaintext credential material. It must never be logged or stored unencrypted. */
export interface OAuthSecret {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. A five-minute safety skew is already applied. */
  expiresAt: number;
  idToken?: string;
  /**
   * Provider-owned, non-secret routing metadata stored inside the encrypted
   * credential envelope. Shared routing code must treat these fields as
   * opaque and adapters must validate them before use.
   */
  metadata?: Record<string, string>;
}

export interface ProviderIdentity {
  /** Stable provider subject/account id. */
  externalAccountId: string;
  /** Subscription workspace id when the provider separates identity from quota. */
  externalWorkspaceId?: string;
  email?: string;
  displayName?: string;
  plan?: string;
}

export interface OAuthPrivateState {
  provider: ProviderId;
  flow: "paste-code" | "device-code";
  [key: string]: unknown;
}

export type LoginStart =
  | {
      kind: "paste-code";
      authorizationUrl: string;
      expiresAt: number;
      privateState: OAuthPrivateState;
    }
  | {
      kind: "device-code";
      verificationUrl: string;
      userCode: string;
      intervalMs: number;
      expiresAt: number;
      privateState: OAuthPrivateState;
    };

export type LoginProgress =
  | { kind: "pending"; nextPollAt: number; privateState?: OAuthPrivateState }
  | {
      kind: "complete";
      secret: OAuthSecret;
      identity: ProviderIdentity;
    }
  | { kind: "denied"; message?: string }
  | { kind: "expired"; message?: string };

export interface RefreshedCredential {
  secret: OAuthSecret;
  /** Login owns workspace identity; refresh is allowed to update profile fields only. */
  identityPatch?: Pick<ProviderIdentity, "email" | "displayName" | "plan">;
}

export interface DiscoveredModel {
  upstreamId: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: Array<"text" | "image">;
  reasoning: boolean;
  /** Provider-advertised effort values; an empty list means no effort knob. */
  reasoningEfforts?: ModelReasoningEffort[];
  /** Provider behavior that the Anthropic-compatible surface can represent. */
  thinkingModes?: ModelThinkingMode[];
  contextManagement?: {
    clearThinking: boolean;
    compact: boolean;
  };
  etag?: string;
  source: "live" | "fallback";
}

export type ModelReasoningEffort =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelThinkingMode = "adaptive" | "enabled";

export interface ProviderDiscovery {
  models: DiscoveredModel[];
  /** Complete sanitized provider-native catalog, including hidden entries. */
  nativeCatalog?: {
    entries: Array<Record<string, unknown>>;
    etag?: string;
  };
}

export interface QuotaWindow {
  id: string;
  label: string;
  /** Stable provider meter shared by model-scoped windows. */
  meterKey?: string;
  usedFraction?: number;
  remainingFraction?: number;
  resetsAt?: number;
  status: "ok" | "warning" | "exhausted" | "unknown";
  allowed?: boolean;
  limitReached?: boolean;
  scope?: string;
}

export interface QuotaSnapshot {
  provider: ProviderId;
  fetchedAt: number;
  windows: QuotaWindow[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export type ProviderFailureKind =
  | "authentication"
  | "quota"
  | "rate-limit"
  | "transient"
  | "invalid-request"
  | "unknown";

export interface ProviderFailure {
  kind: ProviderFailureKind;
  retryable: boolean;
  reauthenticate: boolean;
  retryAfterMs?: number;
  status: number;
}

export type ProviderAccessVerification =
  | { kind: "ready" }
  | {
      kind: "action-required";
      action: "verify-account";
      actionUrl: string;
    };

export interface PrepareInferenceInput {
  request: AnthropicMessagesRequest;
  upstreamModel: string;
  publicModel: string;
  secret: OAuthSecret;
  identity: ProviderIdentity;
  /** Raw Claude Code session header after gateway validation. */
  sessionId?: string;
  /** Fail-closed input projection chosen by the data plane for cap accounting. */
  projectedInputTokens?: number;
  /** Fail-closed output projection chosen by the data plane for cap accounting. */
  projectedOutputTokens?: number;
  signal: AbortSignal;
}

export interface PrepareResponsesInferenceInput {
  request: CodexResponsesRequest;
  upstreamModel: string;
  publicModel: string;
  secret: OAuthSecret;
  identity: ProviderIdentity;
  /** Validated gateway session id, never a caller-controlled upstream URL. */
  sessionId?: string;
  /** Fail-closed input projection chosen by the data plane for cap accounting. */
  projectedInputTokens?: number;
  /** Fail-closed output projection chosen by the data plane for cap accounting. */
  projectedOutputTokens?: number;
  signal: AbortSignal;
}

export interface ExternalTransportReference {
  id: string;
  profileId: string;
}

export interface ExternalTransportProfile {
  id: string;
  email?: string;
  displayName?: string;
  plan?: string;
  authenticated: boolean;
}

export interface PrepareExternalInferenceInput extends Omit<
  PrepareInferenceInput,
  "secret"
> {
  transport: ExternalTransportReference;
}

export interface PrepareExternalResponsesInferenceInput extends Omit<
  PrepareResponsesInferenceInput,
  "secret"
> {
  transport: ExternalTransportReference;
}

export interface PrepareSearchInput {
  request: CodexSearchRequest;
  upstreamModel: string;
  secret: OAuthSecret;
  identity: ProviderIdentity;
  sessionId?: string;
  signal: AbortSignal;
}

export interface PreparedUpstream {
  url: string;
  init: RequestInit;
  protocol: UpstreamProtocol;
  publicModel: string;
  upstreamModel: string;
  /** Protocol exposed back to the caller after transformResponse. */
  publicProtocol: UpstreamProtocol;
  /** Extract a normalized quota patch from inference response headers. */
  observeHeaders(headers: Headers): QuotaSnapshot | null;
  /** Convert a successful upstream response to the Anthropic public surface. */
  transformResponse(response: Response): Promise<Response>;
  /** Transport-specific failures may differ from the provider's direct API. */
  classifyFailure?(
    status: number,
    headers: Headers,
    body?: unknown,
  ): ProviderFailure;
}

export interface PreparedSearchUpstream {
  url: string;
  init: RequestInit;
  observeHeaders(headers: Headers): QuotaSnapshot | null;
}

export interface CodexCatalogCapabilities {
  /** Selector sent back by Codex for this provider's catalog entries. */
  modelIdSource: "upstream" | "public";
  supportsSearchTool: boolean;
  toolMode: "direct" | "code_mode" | "code_mode_only";
  webSearchToolType: "text" | "text_and_image" | null;
}

export interface SubscriptionProviderAdapter {
  readonly id: ProviderId;
  /** Provider-reviewed Codex client surface; required for every new adapter. */
  readonly codexCatalog: CodexCatalogCapabilities;
  startLogin(signal?: AbortSignal): Promise<LoginStart>;
  /** One exchange/poll step. Device flows deliberately do not hold a server request open. */
  continueLogin(
    state: OAuthPrivateState,
    pastedInput?: string,
    signal?: AbortSignal,
  ): Promise<LoginProgress>;
  refresh(
    secret: OAuthSecret,
    signal?: AbortSignal,
  ): Promise<RefreshedCredential>;
  discover(
    secret: OAuthSecret,
    signal?: AbortSignal,
  ): Promise<ProviderDiscovery>;
  fetchQuota(
    secret: OAuthSecret,
    identity: ProviderIdentity,
    signal?: AbortSignal,
  ): Promise<QuotaSnapshot>;
  /** Optional account-readiness probe exposed only through the control plane. */
  verifyAccess?(
    secret: OAuthSecret,
    identity: ProviderIdentity,
    signal?: AbortSignal,
  ): Promise<ProviderAccessVerification>;
  prepareInference(input: PrepareInferenceInput): Promise<PreparedUpstream>;
  /** Codex Responses lane. Every enabled provider must implement this contract. */
  prepareResponsesInference(
    input: PrepareResponsesInferenceInput,
  ): Promise<PreparedUpstream>;
  /** Optional private bridge transport, selected per connected account. */
  prepareExternalInference?(
    input: PrepareExternalInferenceInput,
  ): Promise<PreparedUpstream>;
  prepareExternalResponsesInference?(
    input: PrepareExternalResponsesInferenceInput,
  ): Promise<PreparedUpstream>;
  discoverExternal?(
    transport: ExternalTransportReference,
    signal?: AbortSignal,
  ): Promise<ProviderDiscovery>;
  fetchExternalQuota?(
    transport: ExternalTransportReference,
    signal?: AbortSignal,
  ): Promise<QuotaSnapshot>;
  listExternalProfiles?(
    transportId: string,
    signal?: AbortSignal,
  ): Promise<ExternalTransportProfile[]>;
  /** Codex standalone web-search lane. Providers may opt out. */
  prepareSearch?(input: PrepareSearchInput): Promise<PreparedSearchUpstream>;
  /** Native token counting when the subscription provider exposes it. */
  prepareTokenCount?(input: PrepareInferenceInput): Promise<PreparedUpstream>;
  classifyFailure(
    status: number,
    headers: Headers,
    body?: unknown,
  ): ProviderFailure;
}

export interface AdapterDependencies {
  fetch: typeof fetch;
  now: () => number;
  randomUUID: () => string;
}

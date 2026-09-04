import type {
  AdapterDependencies,
  DiscoveredModel,
  LoginProgress,
  ModelReasoningEffort,
  OAuthPrivateState,
  OAuthSecret,
  ProviderDiscovery,
  ProviderIdentity,
  QuotaSnapshot,
  QuotaWindow,
  SubscriptionProviderAdapter,
} from "./types";

import { anthropicSseToCodexResponses } from "../translate/anthropic-to-codex";
import { codexToAnthropic } from "../translate/codex-to-anthropic";
import { generateOAuthState, generatePkce } from "./pkce";
import {
  DEFAULT_ADAPTER_DEPENDENCIES,
  MAX_PROVIDER_MODEL_ROWS,
  ProviderProtocolError,
  assertRecord,
  clampFraction,
  classifyHttpFailure,
  expectJson,
  fetchWithTimeout,
  finiteNumber,
  isRecord,
  mergeHeadersForPublicResponse,
  nonEmptyString,
  normalizeSessionId,
  providerModelId,
  quotaStatus,
  readBoundedJson,
} from "./shared";
import {
  buildAntigravityRequest,
  transformAntigravityResponse,
} from "./antigravity-wire";

export const ANTIGRAVITY_ENDPOINTS = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
  callback: "http://localhost:51121/oauth-callback",
  daily: "https://daily-cloudcode-pa.googleapis.com",
  production: "https://cloudcode-pa.googleapis.com",
  loadCodeAssist:
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUser:
    "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
  streamGenerateContent:
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
} as const;

// Google issues this installed-application client to Antigravity. Installed
// application credentials are embedded by design and cannot be confidential;
// the user authorization code remains protected by PKCE.
const PUBLIC_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const PUBLIC_CLIENT_SECRET = "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";
const CLIENT_VERSION = "2.9.1";
const LOGIN_TTL_MS = 15 * 60_000;
const TOKEN_SKEW_MS = 5 * 60_000;
const OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;
const CATALOG_PATH = "/v1internal:fetchAvailableModels";
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
const IDE_METADATA = { ideType: "ANTIGRAVITY" } as const;
const CATALOG_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINTS.daily,
  ANTIGRAVITY_ENDPOINTS.production,
] as const;
const GOOGLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const boundedText = (value: unknown, maxLength: number): string | undefined => {
  const text = nonEmptyString(value);

  return text && text.length <= maxLength ? text : undefined;
};

interface AntigravityLoginState extends OAuthPrivateState {
  provider: "antigravity";
  flow: "paste-code";
  verifier: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
}

interface ProjectContext {
  projectId: string;
  plan?: string;
}

type AntigravityModelEntry = Record<string, unknown>;

const platformName = (): string => {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;

  return `${os}/${arch}`;
};

const antigravityUserAgent = (): string =>
  `antigravity/hub/${CLIENT_VERSION} ${platformName()}`;

const authenticatedHeaders = (
  accessToken: string,
  accept = "application/json",
): Headers =>
  new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": antigravityUserAgent(),
  });

const projectIdFromSecret = (secret: OAuthSecret): string => {
  const projectId = nonEmptyString(secret.metadata?.projectId);

  if (!projectId || !GOOGLE_ID.test(projectId))
    throw new ProviderProtocolError(
      "Google account credential is missing its managed project",
      401,
    );

  return projectId;
};

export function createAntigravityProviderAdapter(
  overrides: Partial<AdapterDependencies> = {},
): SubscriptionProviderAdapter {
  const deps = { ...DEFAULT_ADAPTER_DEPENDENCIES, ...overrides };

  return {
    id: "antigravity",
    codexCatalog: {
      modelIdSource: "public",
      supportsSearchTool: false,
      toolMode: "direct",
      webSearchToolType: null,
    },

    async startLogin(signal) {
      signal?.throwIfAborted();
      const pkce = generatePkce();
      const state = generateOAuthState();
      const expiresAt = deps.now() + LOGIN_TTL_MS;
      const url = new URL(ANTIGRAVITY_ENDPOINTS.authorize);

      url.searchParams.set("client_id", PUBLIC_CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", ANTIGRAVITY_ENDPOINTS.callback);
      url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent select_account");
      url.searchParams.set("include_granted_scopes", "true");
      const privateState: AntigravityLoginState = {
        provider: "antigravity",
        flow: "paste-code",
        verifier: pkce.verifier,
        state,
        redirectUri: ANTIGRAVITY_ENDPOINTS.callback,
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
        return { kind: "expired", message: "Google login expired" };
      if (!pastedInput?.trim())
        throw new ProviderProtocolError(
          "Google authorization code is required",
        );
      const callback = parseCallback(pastedInput, state.state);

      if (!callback || callback.state !== state.state)
        throw new ProviderProtocolError("Google OAuth state did not match");
      const tokenPayload = await tokenRequest(
        deps,
        {
          grant_type: "authorization_code",
          client_id: PUBLIC_CLIENT_ID,
          client_secret: PUBLIC_CLIENT_SECRET,
          code: callback.code,
          redirect_uri: state.redirectUri,
          code_verifier: state.verifier,
        },
        signal,
      );
      const baseSecret = parseToken(tokenPayload, deps.now());
      const [profile, project] = await Promise.all([
        fetchGoogleIdentity(deps, baseSecret.accessToken, signal),
        resolveProjectContext(deps, baseSecret.accessToken, signal),
      ]);
      const secret: OAuthSecret = {
        ...baseSecret,
        metadata: { projectId: project.projectId },
      };
      const identity: ProviderIdentity = {
        ...profile,
        externalWorkspaceId: project.projectId,
        ...(project.plan ? { plan: project.plan } : {}),
      };

      return { kind: "complete", secret, identity };
    },

    async refresh(secret, signal) {
      const payload = await tokenRequest(
        deps,
        {
          grant_type: "refresh_token",
          client_id: PUBLIC_CLIENT_ID,
          client_secret: PUBLIC_CLIENT_SECRET,
          refresh_token: secret.refreshToken,
        },
        signal,
      );
      const refreshed = parseToken(
        payload,
        deps.now(),
        secret.refreshToken,
        secret.metadata,
      );
      const profile = await fetchGoogleIdentity(
        deps,
        refreshed.accessToken,
        signal,
      ).catch(() => null);

      return {
        secret: refreshed,
        identityPatch: {
          email: profile?.email,
          displayName: profile?.displayName,
        },
      };
    },

    async discover(secret, signal) {
      const payload = await fetchCatalog(
        deps,
        secret.accessToken,
        projectIdFromSecret(secret),
        signal,
      );

      return parseAntigravityCatalog(payload);
    },

    async fetchQuota(secret, _identity, signal) {
      const projectId = projectIdFromSecret(secret);
      const [catalogResult, summaryResult] = await Promise.allSettled([
        fetchCatalog(deps, secret.accessToken, projectId, signal),
        fetchFromKnownOrigins(
          deps,
          QUOTA_PATH,
          secret.accessToken,
          { project: projectId },
          "Google quota lookup",
          256 * 1024,
          signal,
        ),
      ]);

      if (summaryResult.status === "fulfilled") {
        try {
          return parseAntigravityQuotaSummary(
            summaryResult.value,
            deps.now(),
            catalogResult.status === "fulfilled"
              ? catalogResult.value
              : undefined,
          );
        } catch (error) {
          if (catalogResult.status !== "fulfilled") throw error;
        }
      }
      if (catalogResult.status === "fulfilled")
        return parseAntigravityCatalogQuota(catalogResult.value, deps.now());

      // Prefer the catalog error because it is the required live source used
      // by both discovery and legacy quota responses.
      throw catalogResult.reason;
    },

    async verifyAccess(secret, _identity, signal) {
      const catalog = await fetchCatalog(
        deps,
        secret.accessToken,
        projectIdFromSecret(secret),
        signal,
      );
      const models = parseAntigravityCatalog(catalog).models;
      const model =
        models.find(({ upstreamId }) =>
          /(?:^|[-_.])gemini(?:[-_.]|$)/i.test(upstreamId),
        ) ?? models[0];

      if (!model)
        throw new ProviderProtocolError(
          "Google account has no model available for access verification",
        );
      const sessionId = deps.randomUUID();
      const rewritten = buildAntigravityRequest({
        request: {
          model: model.upstreamId,
          messages: [{ role: "user", content: "Reply OK." }],
          max_tokens: 1,
          stream: true,
        },
        upstreamModel: model.upstreamId,
        projectId: projectIdFromSecret(secret),
        sessionId,
        timestamp: deps.now(),
      });
      const response = await fetchWithTimeout(
        deps.fetch,
        ANTIGRAVITY_ENDPOINTS.streamGenerateContent,
        {
          method: "POST",
          headers: authenticatedHeaders(
            secret.accessToken,
            "text/event-stream",
          ),
          body: rewritten.body,
        },
        30_000,
        signal,
      );

      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);

        return { kind: "ready" };
      }
      const payload = await readBoundedJson(response, 256 * 1024);
      const actionUrl = googleVerificationUrl(payload);

      if (response.status === 403 && actionUrl) {
        return {
          kind: "action-required",
          action: "verify-account",
          actionUrl,
        };
      }
      throw new ProviderProtocolError(
        `Google access verification failed with HTTP ${response.status}`,
        response.status,
      );
    },

    async prepareInference(input) {
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const rewritten = buildAntigravityRequest({
        request: input.request,
        upstreamModel: input.upstreamModel,
        projectId: projectIdFromSecret(input.secret),
        sessionId,
        timestamp: deps.now(),
      });

      return {
        url: ANTIGRAVITY_ENDPOINTS.streamGenerateContent,
        init: {
          method: "POST",
          headers: authenticatedHeaders(
            input.secret.accessToken,
            "text/event-stream",
          ),
          body: rewritten.body,
          redirect: "error",
          signal: input.signal,
        },
        protocol: "anthropic",
        publicProtocol: "anthropic",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: () => null,
        transformResponse: (response) =>
          transformAntigravityResponse(response, {
            publicModel: input.publicModel,
            requestStream: input.request.stream === true,
            toolNames: rewritten.toolNames,
          }),
      };
    },

    async prepareResponsesInference(input) {
      const converted = codexToAnthropic(input.request, {
        model: input.upstreamModel,
        maxOutputTokens: Math.max(1, input.projectedOutputTokens ?? 64_000),
      });
      const sessionId = normalizeSessionId(input.sessionId, deps.randomUUID());
      const rewritten = buildAntigravityRequest({
        request: converted.request,
        upstreamModel: input.upstreamModel,
        projectId: projectIdFromSecret(input.secret),
        sessionId,
        timestamp: deps.now(),
      });

      return {
        url: ANTIGRAVITY_ENDPOINTS.streamGenerateContent,
        init: {
          method: "POST",
          headers: authenticatedHeaders(
            input.secret.accessToken,
            "text/event-stream",
          ),
          body: rewritten.body,
          redirect: "error",
          signal: input.signal,
        },
        protocol: "anthropic",
        publicProtocol: "responses",
        publicModel: input.publicModel,
        upstreamModel: input.upstreamModel,
        observeHeaders: () => null,
        transformResponse: async (response) => {
          const anthropic = await transformAntigravityResponse(response, {
            publicModel: input.publicModel,
            requestStream: true,
            toolNames: rewritten.toolNames,
          });

          if (!anthropic.body)
            throw new ProviderProtocolError(
              "Google returned an empty translated stream",
            );

          return new Response(
            anthropicSseToCodexResponses(anthropic.body, {
              publicModel: input.publicModel,
              toolIdentities: converted.toolIdentities,
            }),
            {
              status: anthropic.status,
              headers: mergeHeadersForPublicResponse(
                anthropic,
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

function parseLoginState(value: OAuthPrivateState): AntigravityLoginState {
  if (
    value.provider !== "antigravity" ||
    value.flow !== "paste-code" ||
    typeof value.verifier !== "string" ||
    typeof value.state !== "string" ||
    value.redirectUri !== ANTIGRAVITY_ENDPOINTS.callback ||
    typeof value.expiresAt !== "number"
  ) {
    throw new ProviderProtocolError("Invalid Google login state");
  }

  return value as AntigravityLoginState;
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
    // A headless flow may expose just the code.
  }
  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");

  if (code && state) return { code, state };

  return /^[A-Za-z0-9._~/-]{8,4096}$/u.test(trimmed)
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
    ANTIGRAVITY_ENDPOINTS.token,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    },
    20_000,
    signal,
  );

  return assertRecord(
    await expectJson(response, "Google token exchange", 64 * 1024),
    "Google token response",
  );
}

function parseToken(
  payload: Record<string, unknown>,
  now: number,
  fallbackRefresh?: string,
  metadata?: Record<string, string>,
): OAuthSecret {
  const accessToken = nonEmptyString(payload.access_token);
  const refreshToken = nonEmptyString(payload.refresh_token) ?? fallbackRefresh;
  const expiresIn = finiteNumber(payload.expires_in);

  if (!accessToken || !refreshToken || !expiresIn || expiresIn <= 0) {
    throw new ProviderProtocolError(
      "Google token response omitted required fields",
    );
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1_000 - TOKEN_SKEW_MS,
    ...(nonEmptyString(payload.id_token)
      ? { idToken: nonEmptyString(payload.id_token) }
      : {}),
    ...(metadata ? { metadata: { ...metadata } } : {}),
  };
}

async function fetchGoogleIdentity(
  deps: AdapterDependencies,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProviderIdentity> {
  const response = await fetchWithTimeout(
    deps.fetch,
    ANTIGRAVITY_ENDPOINTS.userinfo,
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
  const profile = assertRecord(
    await expectJson(response, "Google user lookup", 64 * 1024),
    "Google user response",
  );
  const id = nonEmptyString(profile.id) ?? nonEmptyString(profile.sub);

  if (!id || !GOOGLE_ID.test(id))
    throw new ProviderProtocolError(
      "Google user response omitted a stable account id",
    );

  return {
    externalAccountId: id,
    email: boundedText(profile.email, 320)?.toLowerCase(),
    displayName: boundedText(profile.name, 200),
  };
}

const projectFromPayload = (
  payload: Record<string, unknown>,
): string | null => {
  const value = payload.cloudaicompanionProject;
  const projectId =
    typeof value === "string"
      ? nonEmptyString(value)
      : isRecord(value)
        ? nonEmptyString(value.id)
        : undefined;

  if (!projectId) return null;
  if (!GOOGLE_ID.test(projectId))
    throw new ProviderProtocolError(
      "Google project response contained an invalid project id",
    );

  return projectId;
};

const planFromPayload = (
  payload: Record<string, unknown>,
): string | undefined => {
  const current = isRecord(payload.currentTier)
    ? nonEmptyString(payload.currentTier.id)
    : undefined;
  const paid =
    typeof payload.paidTier === "string"
      ? nonEmptyString(payload.paidTier)
      : isRecord(payload.paidTier)
        ? nonEmptyString(payload.paidTier.id)
        : undefined;

  return boundedText(paid ?? current, 120);
};

const defaultTierFromPayload = (payload: Record<string, unknown>): string => {
  if (Array.isArray(payload.allowedTiers)) {
    const tiers = payload.allowedTiers.filter(isRecord);
    const selected = tiers.find((tier) => tier.isDefault === true) ?? tiers[0];
    const id = boundedText(selected?.id, 256);

    if (id && GOOGLE_ID.test(id)) return id;
  }

  return planFromPayload(payload) ?? "free-tier";
};

async function resolveProjectContext(
  deps: AdapterDependencies,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProjectContext> {
  const response = await fetchWithTimeout(
    deps.fetch,
    ANTIGRAVITY_ENDPOINTS.loadCodeAssist,
    {
      method: "POST",
      headers: authenticatedHeaders(accessToken),
      body: JSON.stringify({ metadata: IDE_METADATA }),
    },
    20_000,
    signal,
  );
  const payload = assertRecord(
    await expectJson(response, "Google project lookup", 256 * 1024),
    "Google project response",
  );
  const existing = projectFromPayload(payload);

  if (existing) return { projectId: existing, plan: planFromPayload(payload) };
  const projectId = await onboardUser(
    deps,
    accessToken,
    defaultTierFromPayload(payload),
    signal,
  );

  return { projectId, plan: planFromPayload(payload) };
}

async function onboardUser(
  deps: AdapterDependencies,
  accessToken: string,
  tierId: string,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted();
    const response = await fetchWithTimeout(
      deps.fetch,
      ANTIGRAVITY_ENDPOINTS.onboardUser,
      {
        method: "POST",
        headers: authenticatedHeaders(accessToken),
        body: JSON.stringify({
          tier_id: tierId,
          metadata: {
            ide_type: "ANTIGRAVITY",
            ide_version: CLIENT_VERSION,
            ide_name: "antigravity",
          },
        }),
      },
      30_000,
      signal,
    );
    const payload = assertRecord(
      await expectJson(response, "Google account onboarding", 256 * 1024),
      "Google onboarding response",
    );
    const nested = isRecord(payload.response) ? payload.response : payload;
    const projectId = projectFromPayload(nested);

    if (payload.done === true && projectId) return projectId;
    if (attempt < 4) await abortableDelay(2_000, signal);
  }

  throw new ProviderProtocolError(
    "Google account onboarding did not return a managed project",
  );
}

const abortableDelay = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
};

async function fetchCatalog(
  deps: AdapterDependencies,
  accessToken: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return fetchFromKnownOrigins(
    deps,
    CATALOG_PATH,
    accessToken,
    { project: projectId },
    "Google model discovery",
    2 * 1024 * 1024,
    signal,
  );
}

async function fetchFromKnownOrigins(
  deps: AdapterDependencies,
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastFailure: ProviderProtocolError | undefined;

  for (const origin of CATALOG_ENDPOINTS) {
    const response = await fetchWithTimeout(
      deps.fetch,
      `${origin}${path}`,
      {
        method: "POST",
        headers: authenticatedHeaders(accessToken),
        body: JSON.stringify(body),
      },
      20_000,
      signal,
    );

    if (response.ok) {
      return assertRecord(
        await readBoundedJson(response, maxBytes),
        `${label} response`,
      );
    }
    const status = response.status;

    await response.body?.cancel().catch(() => undefined);
    lastFailure = new ProviderProtocolError(
      `${label} failed with HTTP ${status}`,
      status,
    );
    if (status !== 429 && status < 500) break;
  }

  throw lastFailure ?? new ProviderProtocolError(`${label} failed`);
}

const modelEntries = (
  payload: unknown,
): Array<[string, AntigravityModelEntry]> => {
  if (!isRecord(payload) || !isRecord(payload.models)) return [];
  const entries = Object.entries(payload.models);

  if (entries.length > MAX_PROVIDER_MODEL_ROWS) {
    throw new ProviderProtocolError(
      "Google model discovery returned too many rows",
    );
  }

  return entries.flatMap(([id, value]) =>
    providerModelId(id) && isRecord(value) ? [[id, value]] : [],
  );
};

const modelModalities = (
  model: AntigravityModelEntry,
): Array<"text" | "image"> => {
  const raw = Array.isArray(model.inputModalities)
    ? model.inputModalities
    : Array.isArray(model.supportedInputModalities)
      ? model.supportedInputModalities
      : [];
  const modalities = raw.flatMap((value): Array<"text" | "image"> => {
    const normalized = typeof value === "string" ? value.toLowerCase() : "";

    return normalized === "text" || normalized === "image" ? [normalized] : [];
  });

  return modalities.length
    ? [...new Set<"text" | "image">(modalities)]
    : ["text", "image"];
};

const hasImageOutput = (id: string, model: AntigravityModelEntry): boolean => {
  const raw = Array.isArray(model.outputModalities)
    ? model.outputModalities
    : Array.isArray(model.supportedOutputModalities)
      ? model.supportedOutputModalities
      : [];

  if (raw.length > 0) {
    return raw.some(
      (value) => typeof value === "string" && value.toLowerCase() === "image",
    );
  }

  return /(?:^|[-_.])image(?:[-_.]|$)/i.test(id);
};

const modelReasoning = (id: string, model: AntigravityModelEntry): boolean =>
  model.reasoning === true ||
  model.supportsThinking === true ||
  model.thinking === true ||
  model.thinkingBudget !== undefined ||
  model.thinkingLevel !== undefined ||
  /(?:thinking|reasoning|gemini-3|claude|gpt-oss)/i.test(
    `${id} ${nonEmptyString(model.displayName) ?? ""}`,
  );

const modelReasoningEfforts = (
  model: AntigravityModelEntry,
): ModelReasoningEffort[] => {
  const raw = Array.isArray(model.supportedThinkingLevels)
    ? model.supportedThinkingLevels
    : Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts
      : [];
  const allowed = new Set<ModelReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  return [
    ...new Set(
      raw.flatMap((value): ModelReasoningEffort[] => {
        const normalized =
          typeof value === "string"
            ? (value.toLowerCase() as ModelReasoningEffort)
            : undefined;

        return normalized && allowed.has(normalized) ? [normalized] : [];
      }),
    ),
  ];
};

const positiveInteger = (value: unknown): number | undefined => {
  const parsed = finiteNumber(value);

  return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
};

const displayName = (value: unknown, fallback: string): string => {
  const name = nonEmptyString(value);

  return name && name.length <= 200 ? name : fallback;
};

export function parseAntigravityCatalog(payload: unknown): ProviderDiscovery {
  const entries = modelEntries(payload);
  const models: DiscoveredModel[] = entries.flatMap(([upstreamId, model]) => {
    const name = boundedText(model.displayName ?? model.modelName, 200);

    if (
      !name ||
      model.hidden === true ||
      model.internal === true ||
      String(model.visibility ?? "").toLowerCase() === "hidden" ||
      hasImageOutput(upstreamId, model)
    ) {
      return [];
    }
    const reasoning = modelReasoning(upstreamId, model);
    const efforts = modelReasoningEfforts(model);

    const contextWindow = positiveInteger(model.maxTokens);
    const maxOutputTokens = positiveInteger(model.maxOutputTokens);

    return [
      {
        upstreamId,
        name,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        inputModalities: modelModalities(model),
        reasoning,
        reasoningEfforts: efforts,
        ...(reasoning ? { thinkingModes: ["enabled" as const] } : {}),
        source: "live" as const,
      },
    ];
  });
  const nativeEntries = entries.map(([slug, model]) => {
    const contextWindow = positiveInteger(model.maxTokens);
    const maxOutputTokens = positiveInteger(model.maxOutputTokens);

    return {
      slug,
      display_name: displayName(model.displayName ?? model.modelName, slug),
      ...(contextWindow !== undefined
        ? { max_context_window: contextWindow }
        : {}),
      ...(maxOutputTokens !== undefined
        ? { max_output_tokens: maxOutputTokens }
        : {}),
    };
  });

  if (models.length === 0)
    throw new ProviderProtocolError(
      "Google model discovery returned no publishable models",
    );

  return { models, nativeCatalog: { entries: nativeEntries } };
}

const quotaWindow = (input: {
  id: string;
  label: string;
  meterKey?: string;
  remaining: number;
  resetsAt?: number;
  scope?: string;
}): QuotaWindow => {
  const remaining = clampFraction(input.remaining);
  const used = 1 - remaining;

  return {
    id: input.id,
    label: input.label,
    ...(input.meterKey ? { meterKey: input.meterKey } : {}),
    usedFraction: used,
    remainingFraction: remaining,
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
    status: quotaStatus(used),
    ...(input.scope ? { scope: input.scope } : {}),
  };
};

export function parseAntigravityCatalogQuota(
  payload: unknown,
  now = Date.now(),
): QuotaSnapshot {
  const windows = modelEntries(payload).flatMap(([modelId, model]) => {
    const info = isRecord(model.quotaInfo) ? model.quotaInfo : null;
    const remaining = finiteNumber(info?.remainingFraction);

    if (remaining === undefined) return [];
    const reset = nonEmptyString(info?.resetTime);
    const resetsAt = reset ? Date.parse(reset) : Number.NaN;
    const group = antigravityQuotaGroup(
      `${modelId} ${nonEmptyString(model.displayName) ?? ""}`,
    );

    return [
      quotaWindow({
        id: "subscription",
        label: `${nonEmptyString(model.displayName) ?? modelId} quota`,
        ...(group ? { meterKey: quotaMeterKey(group) } : {}),
        remaining,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
        scope: modelId,
      }),
    ];
  });

  return {
    provider: "antigravity",
    fetchedAt: now,
    windows,
    metadata: { source: "fetchAvailableModels" },
  };
}

export function parseAntigravityQuotaSummary(
  payload: unknown,
  now = Date.now(),
  catalog?: unknown,
): QuotaSnapshot {
  const root = assertRecord(payload, "Google quota response");
  const groups = Array.isArray(root.groups) ? root.groups.filter(isRecord) : [];
  const catalogModels = catalog ? modelEntries(catalog) : [];
  const windows = groups.flatMap((group, groupIndex) => {
    const groupName =
      nonEmptyString(group.displayName) ?? `Quota group ${groupIndex + 1}`;
    const buckets = Array.isArray(group.buckets)
      ? group.buckets.filter(isRecord)
      : [];

    return buckets.flatMap((bucket, bucketIndex) => {
      const remaining = finiteNumber(bucket.remainingFraction);

      if (remaining === undefined) return [];
      const bucketId =
        nonEmptyString(bucket.bucketId) ??
        `bucket-${groupIndex}-${bucketIndex}`;
      const label = nonEmptyString(bucket.displayName) ?? groupName;
      const windowId = nonEmptyString(bucket.window) ?? bucketId;
      const reset = nonEmptyString(bucket.resetTime);
      const resetsAt = reset ? Date.parse(reset) : Number.NaN;
      const quotaGroup = antigravityQuotaGroup(
        `${bucketId} ${groupName} ${nonEmptyString(group.description) ?? ""}`,
      );
      const scopes = quotaGroup
        ? catalogModels
            .filter(
              ([modelId, model]) =>
                antigravityQuotaGroup(
                  `${modelId} ${nonEmptyString(model.displayName) ?? ""}`,
                ) === quotaGroup,
            )
            .map(([modelId]) => modelId)
        : [];
      const effectiveScopes =
        scopes.length > 0
          ? scopes
          : catalogModels.length > 0 && quotaGroup
            ? []
            : [undefined];

      return effectiveScopes.map((scope) =>
        quotaWindow({
          id: windowId,
          label: `${groupName} · ${label}`,
          ...(quotaGroup ? { meterKey: quotaMeterKey(quotaGroup) } : {}),
          remaining,
          ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
          ...(scope ? { scope } : {}),
        }),
      );
    });
  });

  if (windows.length === 0)
    throw new ProviderProtocolError(
      "Google quota response contained no usable windows",
    );

  return {
    provider: "antigravity",
    fetchedAt: now,
    windows,
    metadata: { source: "retrieveUserQuotaSummary" },
  };
}

export function googleVerificationUrl(payload: unknown): string | undefined {
  const root = isRecord(payload) ? payload : null;
  const error = isRecord(root?.error) ? root.error : null;
  const details = Array.isArray(error?.details)
    ? error.details.filter(isRecord)
    : [];
  const validationRequired = details.some(
    (detail) =>
      detail.reason === "VALIDATION_REQUIRED" &&
      detail.domain === "cloudcode-pa.googleapis.com",
  );

  if (!validationRequired) return undefined;
  for (const detail of details) {
    if (!Array.isArray(detail.links)) continue;
    for (const link of detail.links) {
      if (!isRecord(link) || typeof link.url !== "string") continue;
      const raw = link.url.replaceAll("&amp;", "&");

      if (raw.length > 4_096) continue;
      try {
        const url = new URL(raw);

        if (
          url.protocol === "https:" &&
          url.hostname === "accounts.google.com" &&
          url.pathname === "/signin/continue" &&
          !url.username &&
          !url.password
        ) {
          return url.toString();
        }
      } catch {
        // Ignore malformed provider action links.
      }
    }
  }

  return undefined;
}

const antigravityQuotaGroup = (
  value: string,
): "gemini" | "non-gemini" | undefined => {
  const normalized = value.toLowerCase();

  if (/\b3p[-_ ]|claude|gpt[-_ ]?oss|non[-_ ]?gemini/.test(normalized))
    return "non-gemini";
  if (/\bgemini[-_ ]/.test(normalized)) return "gemini";

  return undefined;
};

const quotaMeterKey = (group: "gemini" | "non-gemini"): string =>
  group === "gemini" ? "gemini_models" : "third_party_models";

export const antigravityProviderAdapter = createAntigravityProviderAdapter();

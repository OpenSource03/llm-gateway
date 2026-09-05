import type { AnthropicMessagesRequest } from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "../wire/sse";

import {
  ANTIGRAVITY_ENDPOINTS,
  createAntigravityProviderAdapter,
  googleVerificationUrl,
  parseAntigravityCatalog,
  parseAntigravityCatalogQuota,
  parseAntigravityQuotaSummary,
} from "./antigravity";
import { buildAntigravityRequest } from "./antigravity-wire";
import { ProviderProtocolError } from "./shared";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);

  headers.set("content-type", "application/json");

  return new Response(JSON.stringify(value), { ...init, headers });
}

function sequenceFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: CapturedFetch[];
} {
  const calls: CapturedFetch[] = [];
  let index = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      init,
    });
    const response = responses[index++];

    if (!response) throw new Error("Unexpected mock fetch");

    return response;
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

const googleSecret = {
  accessToken: "google-access",
  refreshToken: "google-refresh",
  expiresAt: NOW + 60_000,
  metadata: { projectId: "managed-project-123" },
};

test("AntiGravity Google OAuth uses PKCE, resolves stable identity, and retains managed project", async () => {
  const mock = sequenceFetch([
    json({
      access_token: "google-access",
      refresh_token: "google-refresh",
      expires_in: 3600,
      id_token: "google-id-token",
    }),
    json({
      id: "google-subject-123",
      email: "Person@Example.com",
      name: "Example Person",
    }),
    json({
      cloudaicompanionProject: { id: "managed-project-123" },
      currentTier: { id: "pro-tier" },
    }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    randomUUID: () => "ab540b5f-c4cd-4425-a773-c870f9550d56",
  });
  const start = await adapter.startLogin();

  assert.equal(start.kind, "paste-code");
  if (start.kind !== "paste-code") return;
  const authorization = new URL(start.authorizationUrl);

  assert.equal(
    authorization.origin + authorization.pathname,
    ANTIGRAVITY_ENDPOINTS.authorize,
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    ANTIGRAVITY_ENDPOINTS.callback,
  );
  assert.match(authorization.searchParams.get("scope") ?? "", /cloud-platform/);
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(start.privateState.provider, "antigravity");

  const callback = new URL(ANTIGRAVITY_ENDPOINTS.callback);

  callback.searchParams.set("code", "authorization-code");
  callback.searchParams.set("state", String(start.privateState.state));
  const progress = await adapter.continueLogin(
    start.privateState,
    callback.toString(),
  );

  assert.equal(progress.kind, "complete");
  if (progress.kind !== "complete") return;
  assert.deepEqual(progress.identity, {
    externalAccountId: "google-subject-123",
    externalWorkspaceId: "managed-project-123",
    email: "person@example.com",
    displayName: "Example Person",
    plan: "pro-tier",
  });
  assert.equal(progress.secret.expiresAt, NOW + 55 * 60_000);
  assert.deepEqual(progress.secret.metadata, {
    projectId: "managed-project-123",
  });
  assert.deepEqual(
    mock.calls.map(({ url }) => url),
    [
      ANTIGRAVITY_ENDPOINTS.token,
      ANTIGRAVITY_ENDPOINTS.userinfo,
      ANTIGRAVITY_ENDPOINTS.loadCodeAssist,
    ],
  );
  const tokenBody = new URLSearchParams(String(mock.calls[0]?.init?.body));

  assert.equal(tokenBody.get("code"), "authorization-code");
  assert.equal(tokenBody.get("code_verifier"), start.privateState.verifier);
  assert.equal(tokenBody.has("client_secret"), true);
  assert.equal(mock.calls[0]?.init?.redirect, "error");
  assert.equal(mock.calls[1]?.init?.redirect, "error");
  assert.equal(mock.calls[2]?.init?.redirect, "error");
});

test("AntiGravity OAuth onboards accounts that do not yet have a managed project", async () => {
  const mock = sequenceFetch([
    json({
      access_token: "google-access",
      refresh_token: "google-refresh",
      expires_in: 3600,
    }),
    json({ id: "google-subject", email: "person@example.com" }),
    json({
      allowedTiers: [
        { id: "other-tier", isDefault: false },
        { id: "selected-tier", isDefault: true },
      ],
      currentTier: { id: "selected-tier" },
    }),
    json({
      done: true,
      response: {
        cloudaicompanionProject: { id: "new-managed-project" },
      },
    }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const start = await adapter.startLogin();

  assert.equal(start.kind, "paste-code");
  if (start.kind !== "paste-code") return;
  const completed = await adapter.continueLogin(
    start.privateState,
    "authorization-code",
  );

  assert.equal(completed.kind, "complete");
  if (completed.kind !== "complete") return;
  assert.equal(completed.identity.externalWorkspaceId, "new-managed-project");
  assert.deepEqual(completed.secret.metadata, {
    projectId: "new-managed-project",
  });
  assert.equal(mock.calls[3]?.url, ANTIGRAVITY_ENDPOINTS.onboardUser);
  assert.equal(
    (JSON.parse(String(mock.calls[3]?.init?.body)) as Record<string, any>)
      .tier_id,
    "selected-tier",
  );
});

test("AntiGravity OAuth rejects callback state mismatches before token exchange", async () => {
  const mock = sequenceFetch([]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const start = await adapter.startLogin();

  assert.equal(start.kind, "paste-code");
  if (start.kind !== "paste-code") return;

  await assert.rejects(
    adapter.continueLogin(
      start.privateState,
      `${ANTIGRAVITY_ENDPOINTS.callback}?code=valid-code&state=attacker-state`,
    ),
    /state did not match/,
  );
  assert.equal(mock.calls.length, 0);
});

test("AntiGravity refresh preserves project context and accepts refresh-token rotation", async () => {
  const mock = sequenceFetch([
    json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 7200,
    }),
    json({ id: "google-subject", email: "NEW@EXAMPLE.COM", name: "New Name" }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const refreshed = await adapter.refresh(googleSecret);

  assert.equal(refreshed.secret.accessToken, "rotated-access");
  assert.equal(refreshed.secret.refreshToken, "rotated-refresh");
  assert.deepEqual(refreshed.secret.metadata, googleSecret.metadata);
  assert.deepEqual(refreshed.identityPatch, {
    email: "new@example.com",
    displayName: "New Name",
  });
});

test("AntiGravity discovery publishes only the live account catalog", async () => {
  const mock = sequenceFetch([
    json({
      models: {
        "gemini-future-model": {
          displayName: "Gemini Future",
          maxTokens: 1_500_000,
          maxOutputTokens: 80_000,
          supportedInputModalities: ["TEXT", "IMAGE"],
          supportsThinking: true,
          supportedThinkingLevels: ["low", "high"],
        },
        "future-provider-model": {
          displayName: "Future Provider Model",
          maxTokens: 400_000,
        },
        "gemini-image-output": {
          displayName: "Image Output",
          supportedOutputModalities: ["TEXT", "IMAGE"],
        },
        "internal-without-name": { maxTokens: 16_384 },
        "hidden-internal": { displayName: "Internal", internal: true },
      },
    }),
  ]);
  const adapter = createAntigravityProviderAdapter({ fetch: mock.fetch });
  const discovery = await adapter.discover(googleSecret);

  assert.deepEqual(
    discovery.models.map(({ upstreamId }) => upstreamId),
    ["gemini-future-model", "future-provider-model"],
  );
  assert.equal(discovery.models[0]?.contextWindow, 1_500_000);
  assert.equal(discovery.models[0]?.maxOutputTokens, 80_000);
  assert.deepEqual(discovery.models[0]?.reasoningEfforts, ["low", "high"]);
  assert.equal(discovery.models[1]?.source, "live");
  assert.equal(
    mock.calls[0]?.url,
    `${ANTIGRAVITY_ENDPOINTS.daily}/v1internal:fetchAvailableModels`,
  );
  assert.deepEqual(JSON.parse(String(mock.calls[0]?.init?.body)), {
    project: "managed-project-123",
  });
});

test("AntiGravity collapses effort routes into Codex-compatible logical models", () => {
  const discovery = parseAntigravityCatalog({
    models: {
      "gemini-3.8-flash-low": {
        displayName: "Gemini 3.8 Flash (Low)",
        maxTokens: 1_000_000,
      },
      "gemini-3.8-flash-medium": {
        displayName: "Gemini 3.8 Flash (Medium)",
        maxTokens: 1_000_000,
      },
      "gemini-3.8-flash-high": {
        displayName: "Gemini 3.8 Flash (High)",
        maxTokens: 1_000_000,
      },
      "gemini-3.5-flash-extra-low": {
        displayName: "Gemini 3.5 Flash (Low)",
      },
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash (Medium)",
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3.5 Flash (High)",
      },
      "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro (Low)" },
      "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)" },
      "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)" },
      "gemini-2.5-flash": { displayName: "Gemini 3.1 Flash Lite" },
      "gemini-2.5-flash-lite": { displayName: "Gemini 3.1 Flash Lite" },
      "gemini-2.5-flash-thinking": { displayName: "Gemini 3.1 Flash Lite" },
      "gemini-3.1-flash-lite": {
        displayName: "Gemini 3.1 Flash Lite",
        maxTokens: 1_000_000,
        supportsThinking: true,
      },
      "future-ordinary-model": { displayName: "Future Ordinary Model" },
    },
  });

  assert.deepEqual(
    discovery.models.map(({ upstreamId, name, reasoningEfforts }) => ({
      upstreamId,
      name,
      reasoningEfforts,
    })),
    [
      {
        upstreamId: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        reasoningEfforts: ["low", "medium", "high"],
      },
      {
        upstreamId: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        reasoningEfforts: ["low", "medium", "high"],
      },
      {
        upstreamId: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        reasoningEfforts: ["low", "high"],
      },
      {
        upstreamId: "gemini-3.1-flash-lite",
        name: "Gemini 3.1 Flash Lite",
        reasoningEfforts: [],
      },
      {
        upstreamId: "future-ordinary-model",
        name: "Future Ordinary Model",
        reasoningEfforts: [],
      },
    ],
  );
  assert.equal(
    discovery.models.find(({ upstreamId }) => upstreamId === "gemini-3.1-pro")
      ?.defaultReasoningEffort,
    "high",
  );
  const flashLite = discovery.models.find(
    ({ upstreamId }) => upstreamId === "gemini-3.1-flash-lite",
  );

  assert.equal(flashLite?.reasoning, true);
  assert.equal(flashLite?.contextWindow, 1_000_000);
  assert.equal(flashLite?.providerMetadata, undefined);
});

test("AntiGravity catalog rejects oversized provider rosters", () => {
  assert.throws(
    () =>
      parseAntigravityCatalog({
        models: Object.fromEntries(
          Array.from({ length: 2_001 }, (_, index) => [
            `dynamic-model-${index}`,
            { displayName: `Model ${index}` },
          ]),
        ),
      }),
    /too many rows/,
  );
});

test("AntiGravity account metadata cannot select an upstream origin or unsafe project", async () => {
  const mock = sequenceFetch([]);
  const adapter = createAntigravityProviderAdapter({ fetch: mock.fetch });

  await assert.rejects(
    adapter.discover({
      ...googleSecret,
      metadata: { projectId: "https://attacker.example/project" },
    }),
    (error) => error instanceof ProviderProtocolError && error.status === 401,
  );
  assert.equal(mock.calls.length, 0);
});

test("AntiGravity quota normalizes group windows to matching live models", () => {
  const catalog = {
    models: {
      "gemini-dynamic": { displayName: "Gemini Dynamic" },
      "claude-dynamic": { displayName: "Claude Dynamic" },
    },
  };
  const quota = parseAntigravityQuotaSummary(
    {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-5h",
              displayName: "Five hour",
              remainingFraction: 0.75,
              resetTime: "2026-09-04T17:00:00Z",
            },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly",
              remainingFraction: 0.2,
              resetTime: "2026-09-11T12:00:00Z",
            },
          ],
        },
      ],
    },
    NOW,
    catalog,
  );

  assert.deepEqual(
    quota.windows.map((window) => [
      window.id,
      window.meterKey,
      window.scope,
      window.usedFraction,
      window.status,
    ]),
    [
      ["gemini-5h", "gemini_models", "gemini-dynamic", 0.25, "ok"],
      ["3p-weekly", "third_party_models", "claude-dynamic", 0.8, "ok"],
    ],
  );

  const legacy = parseAntigravityCatalogQuota(
    {
      models: {
        "future-live-model": {
          displayName: "Future Live Model",
          quotaInfo: {
            remainingFraction: 0.04,
            resetTime: "2026-09-05T12:00:00Z",
          },
        },
      },
    },
    NOW,
  );

  assert.equal(legacy.windows[0]?.scope, "future-live-model");
  assert.equal(legacy.windows[0]?.meterKey, undefined);
  assert.equal(legacy.windows[0]?.status, "warning");
});

test("AntiGravity quota scopes effort routes to their logical model", () => {
  const quota = parseAntigravityCatalogQuota(
    {
      models: {
        "gemini-3.8-flash-low": {
          displayName: "Gemini 3.8 Flash (Low)",
          quotaInfo: { remainingFraction: 0.8 },
        },
        "gemini-3.8-flash-medium": {
          displayName: "Gemini 3.8 Flash (Medium)",
          quotaInfo: { remainingFraction: 0.7 },
        },
        "gemini-3.8-flash-high": {
          displayName: "Gemini 3.8 Flash (High)",
          quotaInfo: { remainingFraction: 0.6 },
        },
      },
    },
    NOW,
  );

  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0]?.scope, "gemini-3.8-flash");
  assert.equal(quota.windows[0]?.remainingFraction, 0.6);
  assert.equal(quota.windows[0]?.meterKey, "gemini_models");
});

test("AntiGravity quota polling combines live catalog models with provider windows", async () => {
  const mock = sequenceFetch([
    json({
      models: {
        "gemini-dynamic": { displayName: "Gemini Dynamic" },
        "claude-dynamic": { displayName: "Claude Dynamic" },
      },
    }),
    json({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly",
              remainingFraction: 0.5,
            },
          ],
        },
      ],
    }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const quota = await adapter.fetchQuota(googleSecret, {
    externalAccountId: "google-subject",
    externalWorkspaceId: "managed-project-123",
  });

  assert.deepEqual(
    quota.windows.map(({ id, meterKey, scope }) => [id, meterKey, scope]),
    [["gemini-weekly", "gemini_models", "gemini-dynamic"]],
  );
  assert.deepEqual(
    mock.calls.map(({ url }) => url),
    [
      `${ANTIGRAVITY_ENDPOINTS.daily}/v1internal:fetchAvailableModels`,
      `${ANTIGRAVITY_ENDPOINTS.daily}/v1internal:retrieveUserQuotaSummary`,
    ],
  );
});

test("AntiGravity quota polling falls back to live per-model quota when summary shape is unavailable", async () => {
  const mock = sequenceFetch([
    json({
      models: {
        "future-live-model": {
          quotaInfo: { remainingFraction: 0.6 },
        },
      },
    }),
    json({ groups: [] }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const quota = await adapter.fetchQuota(googleSecret, {
    externalAccountId: "google-subject",
  });

  assert.equal(quota.metadata?.source, "fetchAvailableModels");
  assert.equal(quota.windows[0]?.scope, "future-live-model");
});

const requestFixture = (): AnthropicMessagesRequest => ({
  model: "antigravity/gemini-dynamic",
  system: "Provider-neutral harness instructions",
  messages: [
    { role: "user", content: "Inspect this" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "mcp__filesystem__read/path",
          input: { path: "/tmp/example" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "file contents",
        },
      ],
    },
  ],
  tools: [
    {
      name: "mcp__filesystem__read/path",
      description: "Read one file",
      input_schema: {
        type: "object",
        title: "Removed title",
        properties: {
          path: { type: "string", format: "path", const: "/tmp/example" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
  tool_choice: { type: "tool", name: "mcp__filesystem__read/path" },
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  max_tokens: 4_096,
  stream: true,
});

test("AntiGravity routes logical model efforts to the matching live provider ids", async () => {
  const adapter = createAntigravityProviderAdapter();
  const [model] = parseAntigravityCatalog({
    models: {
      "gemini-3.8-flash-low": {
        displayName: "Gemini 3.8 Flash (Low)",
      },
      "gemini-3.8-flash-medium": {
        displayName: "Gemini 3.8 Flash (Medium)",
      },
      "gemini-3.8-flash-high": {
        displayName: "Gemini 3.8 Flash (High)",
      },
    },
  }).models;

  assert.ok(model);
  const anthropic = await adapter.prepareInference({
    request: requestFixture(),
    upstreamModel: model.upstreamId,
    publicModel: `antigravity/${model.upstreamId}`,
    providerMetadata: model.providerMetadata,
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    signal: new AbortController().signal,
  });
  const anthropicBody = JSON.parse(String(anthropic.init.body)) as Record<
    string,
    any
  >;

  assert.equal(anthropic.upstreamModel, "gemini-3.8-flash-high");
  assert.equal(anthropicBody.model, "gemini-3.8-flash-high");

  const responses = await adapter.prepareResponsesInference({
    request: {
      model: `antigravity/${model.upstreamId}`,
      instructions: "Be concise",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      stream: true,
      include: [],
    },
    upstreamModel: model.upstreamId,
    publicModel: `antigravity/${model.upstreamId}`,
    providerMetadata: model.providerMetadata,
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    signal: new AbortController().signal,
  });
  const responsesBody = JSON.parse(String(responses.init.body)) as Record<
    string,
    any
  >;

  assert.equal(responses.upstreamModel, "gemini-3.8-flash-low");
  assert.equal(responsesBody.model, "gemini-3.8-flash-low");

  const defaultRoute = await adapter.prepareInference({
    request: { ...requestFixture(), output_config: undefined },
    upstreamModel: model.upstreamId,
    publicModel: `antigravity/${model.upstreamId}`,
    providerMetadata: model.providerMetadata,
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    signal: new AbortController().signal,
  });

  assert.equal(defaultRoute.upstreamModel, "gemini-3.8-flash-medium");
});

test("AntiGravity request conversion preserves harness instructions, tools, and session affinity", () => {
  const converted = buildAntigravityRequest({
    request: requestFixture(),
    upstreamModel: "gemini-dynamic",
    projectId: "managed-project-123",
    sessionId: "4b38793e-2504-4ec0-a674-276855846461",
    timestamp: NOW,
  });
  const body = JSON.parse(converted.body) as Record<string, any>;
  const declaration = body.request.tools[0].functionDeclarations[0];

  assert.deepEqual(Object.keys(body), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
  ]);
  assert.equal(body.project, "managed-project-123");
  assert.equal(body.model, "gemini-dynamic");
  assert.match(
    body.requestId,
    /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/,
  );
  assert.match(body.request.sessionId, /^-\d+$/);
  assert.deepEqual(body.request.labels, {
    last_step_index: "4",
    trajectory_id: body.request.labels.trajectory_id,
    used_claude: "false",
    used_claude_conservative: "false",
    used_non_gemini_model: "false",
  });
  assert.match(body.request.labels.trajectory_id, /^[0-9a-f-]{36}$/);
  assert.equal(
    body.request.systemInstruction.parts[0].text,
    "Provider-neutral harness instructions",
  );
  assert.equal(declaration.name, "mcp__filesystem__read_path");
  assert.equal(declaration.parametersJsonSchema.title, undefined);
  assert.equal(
    declaration.parametersJsonSchema.additionalProperties,
    undefined,
  );
  assert.deepEqual(declaration.parametersJsonSchema.properties.path.enum, [
    "/tmp/example",
  ]);
  assert.equal(body.request.contents[1].parts[0].functionCall.id, "call-1");
  assert.equal(
    body.request.contents[2].parts[0].functionResponse.name,
    declaration.name,
  );
  assert.deepEqual(
    body.request.toolConfig.functionCallingConfig.allowedFunctionNames,
    [declaration.name],
  );
  assert.deepEqual(body.request.generationConfig.thinkingConfig, {
    thinkingLevel: "high",
  });
  assert.equal(body.request.generationConfig.maxOutputTokens, undefined);
  assert.equal(
    converted.toolNames.get("mcp__filesystem__read_path"),
    "mcp__filesystem__read/path",
  );
});

test("AntiGravity request conversion rejects remote image fetching", () => {
  const request = requestFixture();

  request.messages = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", url: "https://attacker.example/image.png" },
        },
      ],
    },
  ];

  assert.throws(
    () =>
      buildAntigravityRequest({
        request,
        upstreamModel: "gemini-dynamic",
        projectId: "managed-project-123",
        sessionId: "session",
        timestamp: NOW,
      }),
    /inline base64/,
  );
});

test("AntiGravity isolates helper trajectories without breaking multi-turn continuity", () => {
  const sessionId = "23009db6-6f1a-4cd9-bae0-b905f580c38d";
  const request = requestFixture();
  const first = JSON.parse(
    buildAntigravityRequest({
      request,
      upstreamModel: "gemini-dynamic",
      projectId: "managed-project-123",
      sessionId,
      timestamp: NOW,
    }).body,
  ) as Record<string, any>;
  const nextTurn = JSON.parse(
    buildAntigravityRequest({
      request: {
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant", content: "Intermediate answer" },
          { role: "user", content: "Continue" },
        ],
      },
      upstreamModel: "gemini-dynamic",
      projectId: "managed-project-123",
      sessionId,
      timestamp: NOW + 1,
    }).body,
  ) as Record<string, any>;
  const helper = JSON.parse(
    buildAntigravityRequest({
      request: {
        ...request,
        messages: [
          {
            role: "user",
            content: "Generate a short title for another request",
          },
        ],
      },
      upstreamModel: "gemini-dynamic",
      projectId: "managed-project-123",
      sessionId,
      timestamp: NOW,
    }).body,
  ) as Record<string, any>;

  assert.equal(first.request.sessionId, nextTurn.request.sessionId);
  assert.equal(
    first.request.labels.trajectory_id,
    nextTurn.request.labels.trajectory_id,
  );
  assert.notEqual(first.request.sessionId, helper.request.sessionId);
  assert.notEqual(
    first.request.labels.trajectory_id,
    helper.request.labels.trajectory_id,
  );
});

test("AntiGravity stream conversion restores tool names and reports cache-aware usage", async () => {
  const adapter = createAntigravityProviderAdapter({
    randomUUID: () => "8b205fd9-2ce7-4baf-b1fd-f7acdc27a397",
  });
  const prepared = await adapter.prepareInference({
    request: requestFixture(),
    upstreamModel: "gemini-dynamic",
    publicModel: "antigravity/gemini-dynamic",
    secret: googleSecret,
    identity: {
      externalAccountId: "google-subject",
      externalWorkspaceId: "managed-project-123",
    },
    sessionId: "4b38793e-2504-4ec0-a674-276855846461",
    signal: new AbortController().signal,
  });
  const upstreamBody = JSON.parse(String(prepared.init.body)) as Record<
    string,
    any
  >;
  const wireName = upstreamBody.request.tools[0].functionDeclarations[0]
    .name as string;
  const upstream = new Response(
    streamFromStrings([
      `data: ${JSON.stringify({
        response: {
          responseId: "google-response",
          modelVersion: "gemini-dynamic-v1",
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: "private reasoning",
                    thought: true,
                    thoughtSignature: "google-signature",
                  },
                  { text: "I will inspect it." },
                ],
              },
            },
          ],
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call-upstream",
                      name: wireName,
                      args: { path: "/tmp/example" },
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            cachedContentTokenCount: 80,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 8,
            totalTokenCount: 140,
          },
        },
      })}\n\n`,
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const transformed = await prepared.transformResponse(upstream);
  const events: Array<Record<string, any>> = [];

  for await (const frame of parseSseStream(transformed.body!)) {
    events.push(JSON.parse(frame.data) as Record<string, any>);
  }
  const tool = events.find(
    (event) =>
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use",
  );
  const signature = events.find(
    (event) => event.delta?.type === "signature_delta",
  );
  const messageDelta = events.find((event) => event.type === "message_delta");

  assert.equal(tool?.content_block.name, "mcp__filesystem__read/path");
  assert.equal(tool?.content_block.id, "call-upstream");
  assert.equal(signature?.delta.signature, "google-signature");
  assert.deepEqual(messageDelta?.usage, {
    input_tokens: 40,
    output_tokens: 20,
    cache_read_input_tokens: 80,
  });
  assert.equal(messageDelta?.delta.stop_reason, "tool_use");
  assert.equal(prepared.url, ANTIGRAVITY_ENDPOINTS.streamGenerateContent);
  assert.equal(
    new Headers(prepared.init.headers).get("authorization"),
    "Bearer google-access",
  );
});

test("AntiGravity Codex lane translates native Responses requests and events", async () => {
  const adapter = createAntigravityProviderAdapter({
    randomUUID: () => "9fd3b7e6-28d4-4e55-a39b-ecb30e6dc819",
  });
  const prepared = await adapter.prepareResponsesInference({
    request: {
      model: "antigravity/gemini-dynamic",
      instructions: "Keep the answer short",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Echo text",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      store: false,
      stream: true,
      include: [],
    },
    upstreamModel: "gemini-dynamic",
    publicModel: "antigravity/gemini-dynamic",
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    projectedOutputTokens: 8_192,
    signal: new AbortController().signal,
  });
  const body = JSON.parse(String(prepared.init.body)) as Record<string, any>;

  assert.equal(
    body.request.systemInstruction.parts[0].text,
    "Keep the answer short",
  );
  assert.equal(body.request.contents[0].parts[0].text, "Hello");
  assert.equal(
    body.request.tools[0].functionDeclarations[0].name,
    "mcp__codex__echo",
  );

  const upstream = new Response(
    streamFromStrings([
      `data: ${JSON.stringify({
        response: {
          responseId: "google-response",
          candidates: [
            {
              content: { parts: [{ text: "Hello from Google" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
          },
        },
      })}\n\n`,
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const transformed = await prepared.transformResponse(upstream);
  const eventTypes: string[] = [];

  for await (const frame of parseSseStream(transformed.body!)) {
    eventTypes.push((JSON.parse(frame.data) as { type: string }).type);
  }

  assert.ok(eventTypes.includes("response.output_text.delta"));
  assert.ok(eventTypes.includes("response.completed"));
});

test("AntiGravity stream errors expose no provider-controlled detail", async () => {
  const adapter = createAntigravityProviderAdapter({
    randomUUID: () => "6d0835a8-d315-4f41-99f3-d90b2b53174d",
  });
  const prepared = await adapter.prepareInference({
    request: {
      model: "antigravity/gemini-dynamic",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64,
      stream: true,
    },
    upstreamModel: "gemini-dynamic",
    publicModel: "antigravity/gemini-dynamic",
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    signal: new AbortController().signal,
  });
  const secret = "provider-secret-must-not-leak";
  const transformed = await prepared.transformResponse(
    new Response(
      streamFromStrings([
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "started" }] } }] } })}\n\n`,
        `data: ${JSON.stringify({ error: { message: secret } })}\n\n`,
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const text = await transformed.text();

  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /Upstream provider request failed/);
});

test("AntiGravity stream honors downstream cancellation", async () => {
  const adapter = createAntigravityProviderAdapter({
    randomUUID: () => "c42d8710-bc09-4a91-b27d-50f33e8b1d2f",
  });
  const prepared = await adapter.prepareInference({
    request: {
      model: "antigravity/gemini-dynamic",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64,
      stream: true,
    },
    upstreamModel: "gemini-dynamic",
    publicModel: "antigravity/gemini-dynamic",
    secret: googleSecret,
    identity: { externalAccountId: "google-subject" },
    signal: new AbortController().signal,
  });
  let cancelled = false;
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "started" }] } }] } })}\n\n`,
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await prepared.transformResponse(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const reader = response.body!.getReader();

  await reader.read();
  await reader.cancel("client disconnected");
  assert.equal(cancelled, true);
});

test("AntiGravity discovery preserves provider HTTP status without response-body leakage", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const mock = sequenceFetch([
      json({ error: `provider-secret-${status}` }, { status }),
      ...(status === 429 || status >= 500
        ? [json({ error: `provider-secret-fallback-${status}` }, { status })]
        : []),
    ]);
    const adapter = createAntigravityProviderAdapter({ fetch: mock.fetch });

    await assert.rejects(
      adapter.discover(googleSecret),
      (error) =>
        error instanceof ProviderProtocolError &&
        error.status === status &&
        !error.message.includes("provider-secret"),
    );
  }
});

test("AntiGravity access verification exposes only the pinned Google action URL", async () => {
  const validationPayload = {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "VALIDATION_REQUIRED",
          domain: "cloudcode-pa.googleapis.com",
        },
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [
            {
              description: "Verify your account",
              url: "https://accounts.google.com/signin/continue?service=cloudcode&amp;plt=one-time",
            },
          ],
        },
      ],
    },
  };
  const mock = sequenceFetch([
    json({
      models: {
        "gemini-dynamic": {
          displayName: "Gemini Dynamic",
          maxTokens: 1_000_000,
        },
      },
    }),
    json(validationPayload, { status: 403 }),
  ]);
  const adapter = createAntigravityProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    randomUUID: () => "e3a90ab5-f9e5-4442-be85-dd7d078e0321",
  });
  const result = await adapter.verifyAccess!(googleSecret, {
    externalAccountId: "google-subject",
  });

  assert.deepEqual(result, {
    kind: "action-required",
    action: "verify-account",
    actionUrl:
      "https://accounts.google.com/signin/continue?service=cloudcode&plt=one-time",
  });
  assert.equal(
    googleVerificationUrl({
      ...validationPayload,
      error: {
        ...validationPayload.error,
        details: [
          validationPayload.error.details[0],
          {
            links: [
              {
                url: "https://attacker.example/signin/continue?token=stolen",
              },
            ],
          },
        ],
      },
    }),
    undefined,
  );
});

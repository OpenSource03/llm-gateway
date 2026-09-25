import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { CodexSearchRequest } from "../wire/codex-search";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexClientVersionSource,
  fixedCodexClientVersion,
} from "./codex-client-version";
import {
  OPENAI_CODEX_ENDPOINTS,
  createOpenAICodexProviderAdapter,
  parseCodexCatalog,
  parseCodexModels,
  parseCodexQuota,
  parseCodexQuotaHeaders,
} from "./openai-codex";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);

  headers.set("content-type", "application/json");

  return new Response(JSON.stringify(value), { ...init, headers });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.fixture`;
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

test("OpenAI Codex device login exposes pending state then exchanges a completed code", async () => {
  const accessToken = jwt({
    sub: "person-subject",
    [AUTH_CLAIM]: {
      chatgpt_account_id: "workspace-123",
      chatgpt_plan_type: "plus",
    },
    [PROFILE_CLAIM]: { email: "Person@Example.com" },
  });
  const mock = sequenceFetch([
    json({
      device_auth_id: "device-auth",
      user_code: "ABCD-EFGH",
      interval: 2,
      expires_in: 600,
    }),
    new Response(null, { status: 403 }),
    json({
      authorization_code: "authorization-code",
      code_verifier: "device-verifier",
    }),
    json({
      access_token: accessToken,
      refresh_token: "refresh-token",
      expires_in: 3600,
    }),
  ]);
  const adapter = createOpenAICodexProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    randomUUID: () => "cde59176-b51f-4f1d-8c1a-e164ee61ef11",
  });

  const start = await adapter.startLogin();

  assert.equal(start.kind, "device-code");
  if (start.kind !== "device-code") return;
  assert.equal(
    start.verificationUrl,
    OPENAI_CODEX_ENDPOINTS.deviceVerification,
  );
  assert.equal(start.userCode, "ABCD-EFGH");
  assert.equal(
    start.intervalMs,
    5_000,
    "the adapter adds a conservative polling buffer",
  );
  assert.equal(mock.calls[0]?.url, OPENAI_CODEX_ENDPOINTS.deviceStart);
  assert.equal(mock.calls[0]?.init?.redirect, "error");

  const pending = await adapter.continueLogin(start.privateState);

  assert.deepEqual(pending, { kind: "pending", nextPollAt: NOW + 5_000 });

  const complete = await adapter.continueLogin(start.privateState);

  assert.equal(complete.kind, "complete");
  if (complete.kind !== "complete") return;
  assert.equal(complete.secret.accessToken, accessToken);
  assert.equal(complete.secret.refreshToken, "refresh-token");
  assert.equal(complete.secret.expiresAt, NOW + 55 * 60_000);
  assert.deepEqual(complete.identity, {
    externalAccountId: "workspace-123",
    externalWorkspaceId: "workspace-123",
    email: "person@example.com",
    plan: "plus",
  });

  assert.equal(mock.calls[1]?.url, OPENAI_CODEX_ENDPOINTS.devicePoll);
  assert.equal(mock.calls[2]?.url, OPENAI_CODEX_ENDPOINTS.devicePoll);
  assert.equal(mock.calls[3]?.url, OPENAI_CODEX_ENDPOINTS.token);
  assert.equal(mock.calls[3]?.init?.redirect, "error");
  const exchange = new URLSearchParams(String(mock.calls[3]?.init?.body));

  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("code_verifier"), "device-verifier");
  assert.equal(
    exchange.get("redirect_uri"),
    OPENAI_CODEX_ENDPOINTS.deviceRedirect,
  );
});

test("OpenAI model and quota discovery parsers retain server capabilities", () => {
  const models = parseCodexModels(
    {
      models: [
        {
          slug: "gpt-text-only",
          display_name: "Text Only",
          input_modalities: ["text"],
          default_reasoning_level: "none",
          supported_reasoning_levels: [],
          context_window: 100_000,
          max_context_window: 900_000,
        },
        {
          id: "gpt-reasoning",
          supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
        },
        { id: "hidden", visibility: "hide" },
      ],
    },
    "etag-1",
  );

  assert.deepEqual(
    models.map((model) => ({
      id: model.upstreamId,
      reasoning: model.reasoning,
    })),
    [
      { id: "gpt-text-only", reasoning: false },
      { id: "gpt-reasoning", reasoning: true },
    ],
  );
  assert.deepEqual(models[0]?.inputModalities, ["text"]);
  assert.equal(models[0]?.contextWindow, 900_000);
  assert.deepEqual(models[1]?.reasoningEfforts, ["high", "ultra"]);
  assert.deepEqual(models[1]?.thinkingModes, ["adaptive"]);
  assert.equal(models[0]?.etag, "etag-1");
  const catalog = parseCodexCatalog({
    models: [
      {
        slug: "gpt-text-only",
        default_reasoning_level: "none",
        multi_agent_reasoning_effort: "xhigh",
        unreviewed: "drop",
      },
    ],
  });

  assert.equal(catalog[0]?.slug, "gpt-text-only");
  assert.equal(catalog[0]?.default_reasoning_level, "none");
  assert.equal(catalog[0]?.multi_agent_reasoning_effort, "xhigh");
  assert.equal("unreviewed" in catalog[0]!, false);

  const quota = parseCodexQuota(
    {
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 20, reset_after_seconds: 60 },
        secondary_window: { used_percent: 100, reset_at: 1_786_550_400 },
      },
      additional_rate_limits: [
        {
          metered_feature: "codex_other_models",
          rate_limit: { primary_window: { used_percent: 91 } },
        },
      ],
    },
    NOW,
  );

  assert.deepEqual(
    quota.windows.map((window) => [window.id, window.status]),
    [
      ["chat:primary", "ok"],
      ["chat:secondary", "exhausted"],
      ["codex_other_models:primary", "warning"],
    ],
  );
  assert.equal(quota.windows[0]?.resetsAt, NOW + 60_000);
  assert.equal(quota.windows[0]?.allowed, true);

  const fromHeaders = parseCodexQuotaHeaders(
    new Headers({
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-reset-at": "1786550400",
    }),
    NOW,
  );

  assert.equal(fromHeaders?.windows[0]?.usedFraction, 0.42);
  assert.equal(fromHeaders?.windows[0]?.resetsAt, 1_786_550_400_000);
});

test("OpenAI discovery requests the current Codex catalog contract", async () => {
  const accessToken = jwt({
    sub: "person-subject",
    [AUTH_CLAIM]: {
      chatgpt_account_id: "workspace-123",
      chatgpt_plan_type: "plus",
    },
  });
  const astra = {
    slug: "gpt-6-astra",
    display_name: "GPT-6-Astra",
    visibility: "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }],
    multi_agent_reasoning_effort: "xhigh",
    max_context_window: 872_000,
  };
  const mock = sequenceFetch([
    json({ models: [astra] }, { headers: { etag: '"astra-catalog"' } }),
    json({ models: [astra] }, { headers: { etag: '"astra-catalog"' } }),
  ]);
  const adapter = createOpenAICodexProviderAdapter({
    fetch: mock.fetch,
    clientVersion: fixedCodexClientVersion("0.157.0"),
  });

  const discovery = await adapter.discover({
    accessToken,
    refreshToken: "refresh-token",
    expiresAt: NOW + 60_000,
  });

  assert.deepEqual(discovery.models[0]?.reasoningEfforts, ["medium", "ultra"]);
  assert.equal(discovery.nativeCatalog?.entries[0]?.slug, "gpt-6-astra");
  assert.equal(
    discovery.nativeCatalog?.entries[0]?.multi_agent_reasoning_effort,
    "xhigh",
  );
  for (const call of mock.calls) {
    assert.equal(
      new URL(call.url).searchParams.get("client_version"),
      "0.157.0",
    );
    assert.equal(new Headers(call.init?.headers).get("version"), "0.157.0");
  }
});

test("OpenAI discovery reports the newest stable Codex release to the catalog", async () => {
  const accessToken = jwt({
    sub: "person-subject",
    [AUTH_CLAIM]: { chatgpt_account_id: "workspace-123" },
  });
  const sol = { slug: "gpt-6-sol", display_name: "GPT-6-Sol" };
  const mock = sequenceFetch([
    json({ name: "@openai/codex", version: "0.158.2" }),
    json({ models: [sol] }),
    json({ models: [sol] }),
  ]);
  const adapter = createOpenAICodexProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    clientVersion: createCodexClientVersionSource({
      fetch: mock.fetch,
      now: () => NOW,
      setting: "auto",
    }),
  });

  const discovery = await adapter.discover({
    accessToken,
    refreshToken: "refresh-token",
    expiresAt: NOW + 60_000,
  });

  assert.equal(discovery.models[0]?.upstreamId, "gpt-6-sol");
  assert.deepEqual(discovery.models[0]?.providerMetadata, {
    kind: "openai-codex-model",
    clientVersion: "0.158.2",
  });
  assert.equal(
    mock.calls[0]?.url,
    "https://registry.npmjs.org/@openai/codex/latest",
  );
  for (const call of mock.calls.slice(1)) {
    assert.equal(
      new URL(call.url).searchParams.get("client_version"),
      "0.158.2",
    );
    assert.equal(
      new Headers(call.init?.headers).get("user-agent"),
      "codex_cli_rs/0.158.2",
    );
  }
});

test("OpenAI inference preparation emits the Codex Responses wire contract", async () => {
  const adapter = createOpenAICodexProviderAdapter({
    now: () => NOW,
    randomUUID: () => "131f4bad-a527-4b42-bbf7-4b4adf40079b",
    clientVersion: fixedCodexClientVersion("0.157.0"),
  });
  const request: AnthropicMessagesRequest = {
    model: "openai/gpt-5-codex",
    max_tokens: 500,
    system: "You are a coding agent.",
    messages: [{ role: "user", content: "Fix it" }],
    stream: false,
    thinking: { type: "enabled", budget_tokens: 8_000 },
  };
  const prepared = await adapter.prepareInference({
    request,
    upstreamModel: "gpt-5-codex",
    publicModel: request.model,
    secret: {
      accessToken: "access-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "person", externalWorkspaceId: "workspace" },
    sessionId: "1fd981d9-1206-4d98-8523-35c50db3cb42",
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.url, OPENAI_CODEX_ENDPOINTS.responses);
  assert.equal(prepared.protocol, "responses");
  assert.equal(prepared.init.redirect, "error");
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("chatgpt-account-id"), "workspace");
  assert.equal(headers.get("openai-beta"), "responses=experimental");
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("x-codex-routing-hint"), "model=gpt-5-codex");
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(body.model, "gpt-5-codex");
  assert.equal(
    body.stream,
    true,
    "Codex upstream always streams; the gateway aggregates when needed",
  );
  assert.equal(body.store, false);
  assert.equal(body.instructions, "You are a coding agent.");
  assert.equal("max_output_tokens" in body, false);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
});

test("OpenAI native Codex preparation preserves reviewed Responses fields", async () => {
  const adapter = createOpenAICodexProviderAdapter({
    now: () => NOW,
    randomUUID: () => "131f4bad-a527-4b42-bbf7-4b4adf40079b",
    clientVersion: fixedCodexClientVersion("0.157.0"),
  });

  assert.ok(adapter.prepareResponsesInference);
  const prepared = await adapter.prepareResponsesInference({
    request: {
      model: "openai/gpt-5.6-luna",
      instructions: "Act as a coding agent.",
      input: [{ type: "message", role: "user", content: [] }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium", context: "all_turns" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "cache-key",
      service_tier: "priority",
      client_metadata: { thread_id: "thread-id" },
    },
    upstreamModel: "gpt-5.6-luna",
    publicModel: "openai/gpt-5.6-luna",
    secret: {
      accessToken: "access-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "person", externalWorkspaceId: "workspace" },
    sessionId: "1fd981d9-1206-4d98-8523-35c50db3cb42",
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.publicProtocol, "responses");
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("chatgpt-account-id"), "workspace");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.service_tier, "priority");
  assert.equal(
    headers.get("x-codex-routing-hint"),
    "model=gpt-5.6-luna;tier=priority",
  );
  assert.deepEqual(body.reasoning, { effort: "medium", context: "all_turns" });

  const publicResponse = await prepared.transformResponse(
    new Response("event: response.completed\ndata: {}\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "must-not-leak=1",
      },
    }),
  );

  assert.equal(
    publicResponse.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(publicResponse.headers.get("set-cookie"), null);
});

test("OpenAI Codex search preparation uses the dedicated subscription endpoint", async () => {
  const adapter = createOpenAICodexProviderAdapter({
    now: () => NOW,
    clientVersion: fixedCodexClientVersion("0.157.0"),
  });

  assert.ok(adapter.prepareSearch);
  const request: CodexSearchRequest = {
    id: "search-id",
    model: "anthropic/claude-opus-5",
    input: "Find Codex docs",
    commands: { search_query: [{ q: "Codex docs" }] },
    settings: { external_web_access: true },
    max_output_tokens: 512,
  };
  const prepared = await adapter.prepareSearch({
    request,
    upstreamModel: "gpt-5.6-luna",
    secret: {
      accessToken: "access-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "person", externalWorkspaceId: "workspace" },
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.url, OPENAI_CODEX_ENDPOINTS.search);
  assert.equal(prepared.init.redirect, "error");
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("chatgpt-account-id"), "workspace");
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.id, "search-id");
});

test("OpenAI quota windows are named by their reported length, not their slot", () => {
  const ids = (payload: Record<string, unknown>) =>
    parseCodexQuota(payload, NOW).windows.map((window) => [
      window.id,
      window.scope,
    ]);

  // A plan with only a weekly window reports it in the primary slot.
  assert.deepEqual(
    ids({
      rate_limit: {
        primary_window: { used_percent: 78, limit_window_seconds: 604_800 },
        secondary_window: null,
      },
    }),
    [["seven_day", undefined]],
  );
  assert.deepEqual(
    ids({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
      },
      additional_rate_limits: [
        {
          metered_feature: "codex_other_models",
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 86_400 },
          },
        },
      ],
    }),
    [
      ["five_hour", undefined],
      ["seven_day", undefined],
      ["codex_other_models:window_1440m", "codex_other_models"],
    ],
  );
  // Two windows of one length keep distinct slot keys.
  assert.deepEqual(
    ids({
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604_800 },
      },
    }),
    [
      ["chat:primary", undefined],
      ["chat:secondary", undefined],
    ],
  );

  const fromHeaders = parseCodexQuotaHeaders(
    new Headers({
      "x-codex-primary-used-percent": "78",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-secondary-used-percent": "0",
    }),
    NOW,
  );

  assert.deepEqual(
    fromHeaders?.windows.map((window) => window.id),
    ["seven_day", "chat:secondary"],
  );
});

test("OpenAI requests never report an older client than the model's discovery", async () => {
  const mock = registry157();
  const adapter = createOpenAICodexProviderAdapter({
    now: () => NOW,
    randomUUID: () => "131f4bad-a527-4b42-bbf7-4b4adf40079b",
    clientVersion: createCodexClientVersionSource({
      fetch: mock,
      now: () => NOW,
      setting: "auto",
    }),
  });
  const input = (providerMetadata: unknown) => ({
    request: {
      model: "openai/gpt-6-sol",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "Hi" }],
    },
    upstreamModel: "gpt-6-sol",
    publicModel: "openai/gpt-6-sol",
    secret: {
      accessToken: "access-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "person", externalWorkspaceId: "workspace" },
    providerMetadata,
    sessionId: "1fd981d9-1206-4d98-8523-35c50db3cb42",
    signal: new AbortController().signal,
  });
  const version = async (providerMetadata: unknown) =>
    new Headers(
      (await adapter.prepareInference(input(providerMetadata))).init.headers,
    ).get("version");

  // This process's own lookup still says 0.157.0.
  assert.equal(await version(undefined), "0.157.0");
  // Another process discovered the model with 0.158.1; follow it from now on.
  assert.equal(
    await version({ kind: "openai-codex-model", clientVersion: "0.158.1" }),
    "0.158.1",
  );
  assert.equal(await version(undefined), "0.158.1");
  // Foreign, older or malformed metadata never lowers it.
  assert.equal(
    await version({ kind: "openai-codex-model", clientVersion: "0.157.9" }),
    "0.158.1",
  );
  assert.equal(
    await version({ kind: "other", clientVersion: "0.200.0" }),
    "0.158.1",
  );
  assert.equal(
    await version({ kind: "openai-codex-model", clientVersion: "1.0.0" }),
    "0.158.1",
  );
});

function registry157(): typeof fetch {
  return (async () =>
    json({ name: "@openai/codex", version: "0.157.0" })) as typeof fetch;
}

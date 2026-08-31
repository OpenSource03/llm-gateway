import type { AnthropicMessagesRequest } from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "../wire/sse";

import {
  XAI_ENDPOINTS,
  createXaiProviderAdapter,
  mergeXaiModels,
  parseXaiQuota,
  xaiProxyHeaders,
} from "./xai";
import { ProviderProtocolError } from "./shared";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

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

test("xAI OIDC device login enforces discovered hosts and handles pending, slow-down, and completion", async () => {
  const mock = sequenceFetch([
    json({
      issuer: "https://auth.x.ai",
      token_endpoint: XAI_ENDPOINTS.token,
      jwks_uri: "https://auth.x.ai/oauth2/jwks",
      id_token_signing_alg_values_supported: ["ES256"],
    }),
    json({
      device_code: "device-code",
      user_code: "WXYZ-1234",
      verification_uri_complete:
        "https://auth.x.ai/activate?user_code=WXYZ-1234",
      expires_in: 600,
      interval: 5,
    }),
    json({ error: "authorization_pending" }, { status: 400 }),
    json({ error: "slow_down" }, { status: 400 }),
    json({
      access_token: "xai-access",
      refresh_token: "xai-refresh",
      expires_in: 3600,
    }),
    json({ sub: "xai-subject", email: "Person@Example.com", name: "Person" }),
  ]);
  const adapter = createXaiProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    randomUUID: () => "4cd4adeb-c631-46ae-9816-059f78834937",
  });

  const start = await adapter.startLogin();

  assert.equal(start.kind, "device-code");
  if (start.kind !== "device-code") return;
  assert.equal(
    start.verificationUrl,
    "https://auth.x.ai/activate?user_code=WXYZ-1234",
  );
  assert.equal(start.userCode, "WXYZ-1234");
  assert.equal(start.intervalMs, 5_000);
  assert.equal(mock.calls[0]?.url, XAI_ENDPOINTS.discovery);
  assert.equal(mock.calls[1]?.url, XAI_ENDPOINTS.deviceStart);
  assert.equal(mock.calls[0]?.init?.redirect, "error");
  assert.equal(mock.calls[1]?.init?.redirect, "error");

  const pending = await adapter.continueLogin(start.privateState);

  assert.deepEqual(pending, { kind: "pending", nextPollAt: NOW + 5_000 });
  const slowed = await adapter.continueLogin(start.privateState);

  assert.equal(slowed.kind, "pending");
  if (slowed.kind !== "pending") return;
  assert.equal(slowed.nextPollAt, NOW + 10_000);
  assert.equal(slowed.privateState?.intervalMs, 10_000);

  const complete = await adapter.continueLogin(start.privateState);

  assert.equal(complete.kind, "complete");
  if (complete.kind !== "complete") return;
  assert.equal(complete.secret.accessToken, "xai-access");
  assert.equal(complete.secret.expiresAt, NOW + 55 * 60_000);
  assert.deepEqual(complete.identity, {
    externalAccountId: "xai-subject",
    email: "person@example.com",
    displayName: "Person",
  });
  assert.deepEqual(
    mock.calls.slice(2, 5).map((call) => call.url),
    [XAI_ENDPOINTS.token, XAI_ENDPOINTS.token, XAI_ENDPOINTS.token],
  );
  assert.equal(mock.calls[5]?.url, XAI_ENDPOINTS.userinfo);

  await assert.rejects(
    adapter.continueLogin({
      ...start.privateState,
      tokenEndpoint: "https://attacker.example/token",
    }),
    /Invalid xAI token endpoint/,
  );
  assert.equal(
    mock.calls.length,
    6,
    "fixed-host validation occurs before fetch",
  );
});

test("xAI model discovery merges live Grok models with Composer fallbacks", () => {
  const models = mergeXaiModels({
    data: [
      { id: "grok-4.5", context_length: 750_000, max_output_tokens: 80_000 },
      { id: "grok-new", context_length: 300_000 },
      { id: "image-imagine" },
    ],
  });

  assert.equal(
    models.find((model) => model.upstreamId === "grok-4.5")?.source,
    "live",
  );
  assert.equal(
    models.find((model) => model.upstreamId === "grok-4.5")?.contextWindow,
    750_000,
  );
  assert.equal(
    models.find((model) => model.upstreamId === "grok-new")?.source,
    "live",
  );
  assert.equal(
    models.some((model) => model.upstreamId === "grok-composer-2.5-fast"),
    true,
  );
  assert.equal(
    models.some((model) => /imagine/.test(model.upstreamId)),
    false,
  );
});

test("xAI discovery rejects an excessive raw model roster", () => {
  assert.throws(
    () =>
      mergeXaiModels({
        data: Array.from({ length: 2_001 }, (_, index) => ({
          id: `grok-${index}`,
        })),
      }),
    /too many rows/,
  );
});

test("xAI discovery falls back only when the catalog route is absent", async () => {
  const mock = sequenceFetch([json({ error: "not_found" }, { status: 404 })]);
  const adapter = createXaiProviderAdapter({ fetch: mock.fetch });
  const { models } = await adapter.discover({
    accessToken: "xai-access",
    refreshToken: "xai-refresh",
    expiresAt: NOW + 60_000,
  });

  assert.ok(models.length > 0);
  assert.equal(
    models.every((model) => model.source === "fallback"),
    true,
  );
});

test("xAI discovery preserves non-catalog HTTP failures for account health classification", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const mock = sequenceFetch([
      json({ error: `provider-secret-${status}` }, { status }),
    ]);
    const adapter = createXaiProviderAdapter({ fetch: mock.fetch });

    await assert.rejects(
      adapter.discover({
        accessToken: "xai-access",
        refreshToken: "xai-refresh",
        expiresAt: NOW + 60_000,
      }),
      (error) =>
        error instanceof ProviderProtocolError &&
        error.status === status &&
        !error.message.includes(`provider-secret-${status}`),
    );
  }
});

test("xAI quota and CLI proxy headers are normalized", () => {
  const quota = parseXaiQuota(
    {
      subscriptionTier: "supergrok",
      onDemandEnabled: true,
      config: {
        creditUsagePercent: 94,
        currentPeriod: { type: "Monthly", end: "2026-09-01T00:00:00Z" },
        isUnifiedBillingUser: true,
        productUsage: [{ product: "Grok Build", usagePercent: 100 }],
      },
    },
    NOW,
  );

  assert.deepEqual(
    quota.windows.map((window) => [window.id, window.status]),
    [
      ["subscription", "warning"],
      ["product:grok-build", "exhausted"],
    ],
  );
  assert.equal(quota.metadata?.plan, "supergrok");
  assert.equal(quota.metadata?.unifiedBilling, true);

  const headers = xaiProxyHeaders("token", "grok-4.5");

  assert.equal(headers.Authorization, "Bearer token");
  assert.equal(headers["X-XAI-Token-Auth"], "xai-grok-cli");
  assert.equal(headers["x-grok-model-override"], "grok-4.5");
  assert.match(headers["User-Agent"] ?? "", /^grok-shell\/0\.2\.101 /);
});

test("xAI inference preparation emits Responses requests only to the pinned CLI proxy", async () => {
  const adapter = createXaiProviderAdapter({
    now: () => NOW,
    randomUUID: () => "5f5b1a62-dc03-47a0-bb42-bb6385d1feea",
  });
  const request: AnthropicMessagesRequest = {
    model: "xai/grok-4.5",
    max_tokens: 900,
    messages: [{ role: "user", content: "Analyze this" }],
    stream: true,
    thinking: { type: "adaptive" },
    tools: [
      {
        name: "union_tool",
        input_schema: {
          oneOf: [
            {
              type: "object",
              properties: { path: { type: "string", encrypted: true } },
            },
            {
              type: "object",
              properties: { id: { type: "number" } },
            },
          ],
        },
      },
    ],
  };
  const prepared = await adapter.prepareInference({
    request,
    upstreamModel: "grok-4.5",
    publicModel: request.model,
    secret: {
      accessToken: "xai-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "subject" },
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.url, XAI_ENDPOINTS.responses);
  assert.equal(new URL(prepared.url).origin, "https://cli-chat-proxy.grok.com");
  assert.equal(prepared.init.redirect, "error");
  assert.equal(headers.get("authorization"), "Bearer xai-token");
  assert.equal(headers.get("x-grok-model-override"), "grok-4.5");
  assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
  const conversationId = headers.get("x-grok-conv-id");

  assert.match(conversationId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(headers.get("x-grok-session-id"), conversationId);
  assert.equal(
    headers.get("x-grok-req-id"),
    "5f5b1a62-dc03-47a0-bb42-bb6385d1feea",
  );
  assert.equal(body.model, "grok-4.5");
  assert.equal(body.max_output_tokens, 900);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  const parameters = (
    body.tools as Array<{ parameters: Record<string, unknown> }>
  )[0]?.parameters;

  assert.equal(Object.hasOwn(parameters, "oneOf"), false);
  assert.equal(
    (parameters.properties as Record<string, Record<string, unknown>>).path
      .encrypted,
    undefined,
  );
});

test("xAI exposes the provider-neutral native Codex Responses lane", async () => {
  const adapter = createXaiProviderAdapter({
    now: () => NOW,
    randomUUID: () => "5f5b1a62-dc03-47a0-bb42-bb6385d1feea",
  });
  const prepared = await adapter.prepareResponsesInference({
    request: {
      model: "xai/grok-4.5",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Analyze this" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          name: "union_tool",
          parameters: {
            anyOf: [
              { type: "object", properties: { path: { type: "string" } } },
              { type: "object", properties: { id: { type: "number" } } },
            ],
          },
        },
        {
          type: "custom",
          name: "exec",
          description: "Run code",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: /.+/",
          },
        },
      ],
      store: false,
      stream: true,
      include: [],
    },
    upstreamModel: "grok-4.5",
    publicModel: "xai/grok-4.5",
    secret: {
      accessToken: "xai-token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "subject" },
    signal: new AbortController().signal,
  });
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.publicProtocol, "responses");
  assert.equal(body.model, "grok-4.5");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  const parameters = (
    body.tools as Array<{ parameters: Record<string, unknown> }>
  )[0]?.parameters;

  assert.equal(Object.hasOwn(parameters, "anyOf"), false);
  assert.deepEqual(Object.keys(parameters.properties as object).sort(), [
    "id",
    "path",
  ]);
  const custom = (body.tools as Array<Record<string, unknown>>)[1];

  assert.equal(custom?.type, "function");
  assert.equal(custom?.name, "exec");
  assert.deepEqual((custom?.parameters as Record<string, unknown>).required, [
    "input",
  ]);

  const transformed = await prepared.transformResponse(
    new Response(
      streamFromStrings([
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"exec","arguments":"{\\"input\\":\\"pwd\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[]}}\n\n',
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const frames: Array<Record<string, unknown>> = [];

  for await (const frame of parseSseStream(transformed.body!)) {
    frames.push(JSON.parse(frame.data));
  }
  assert.deepEqual(frames[0]?.item, {
    type: "custom_tool_call",
    id: "item-1",
    call_id: "call-1",
    name: "exec",
    input: "pwd",
    status: "completed",
  });
});

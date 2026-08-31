import type { AnthropicMessagesRequest } from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_ENDPOINTS,
  createAnthropicProviderAdapter,
  parseAnthropicModels,
  parseAnthropicQuota,
  parseAnthropicQuotaHeaders,
} from "./anthropic";

test("Claude discovery selects the newest API model in every returned family", () => {
  const models = parseAnthropicModels({
    data: [
      {
        id: "claude-opus-4-8",
        display_name: "Claude Opus 4.8",
        created_at: "2026-01-01T00:00:00Z",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: { image_input: { supported: true } },
      },
      {
        id: "claude-opus-5",
        display_name: "Claude Opus 5",
        created_at: "2026-07-24T00:00:00Z",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: true,
            types: {
              adaptive: { supported: true },
              enabled: { supported: true },
            },
          },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
          },
          context_management: {
            supported: true,
            clear_thinking_20251015: { supported: true },
            compact_20260112: { supported: true },
          },
        },
      },
      {
        id: "claude-sonnet-5",
        display_name: "Claude Sonnet 5",
        created_at: "2026-06-29T00:00:00Z",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: { effort: { supported: true } },
      },
      {
        id: "claude-fable-5",
        display_name: "Claude Fable 5",
        created_at: "2026-06-07T00:00:00Z",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: { thinking: { supported: true } },
      },
    ],
  });

  assert.deepEqual(
    models.map((model) => model.upstreamId),
    ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"],
  );
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.equal(models[0]?.maxOutputTokens, 128_000);
  assert.equal(models[0]?.reasoning, true);
  assert.deepEqual(models[0]?.reasoningEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(models[0]?.thinkingModes, ["adaptive", "enabled"]);
  assert.deepEqual(models[0]?.contextManagement, {
    clearThinking: true,
    compact: true,
  });
});

test("Claude discovery rejects an excessive raw model roster", () => {
  assert.throws(
    () =>
      parseAnthropicModels({
        data: Array.from({ length: 2_001 }, (_, index) => ({
          id: `claude-family-${index}`,
          display_name: `Claude ${index}`,
        })),
      }),
    /too many rows/,
  );
});

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
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

test("Claude OAuth exchanges the displayed authentication code with bootstrap identity", async () => {
  const mock = sequenceFetch([
    json({
      access_token: "claude-access",
      refresh_token: "claude-refresh",
      expires_in: 3600,
    }),
    json({
      oauth_account: {
        account_uuid: "account-uuid",
        account_email: "Person@Example.com",
        organization_uuid: "org-uuid",
        organization_name: "Example Organization",
      },
    }),
  ]);
  const adapter = createAnthropicProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
    randomUUID: () => "a53b3492-1336-4d67-a41d-d754477138ce",
  });

  const start = await adapter.startLogin();

  assert.equal(start.kind, "paste-code");
  if (start.kind !== "paste-code") return;
  const authorization = new URL(start.authorizationUrl);

  assert.equal(
    authorization.origin + authorization.pathname,
    ANTHROPIC_ENDPOINTS.authorize,
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    ANTHROPIC_ENDPOINTS.callback,
  );
  assert.equal(start.privateState.provider, "anthropic");
  assert.equal(typeof start.privateState.verifier, "string");
  assert.equal(start.expiresAt, NOW + 15 * 60_000);

  const progress = await adapter.continueLogin(start.privateState, "auth-code");

  assert.equal(progress.kind, "complete");
  if (progress.kind !== "complete") return;
  assert.deepEqual(progress.identity, {
    externalAccountId: "account-uuid",
    externalWorkspaceId: "org-uuid",
    email: "person@example.com",
    displayName: "Example Organization",
  });
  assert.equal(progress.secret.accessToken, "claude-access");
  assert.equal(progress.secret.refreshToken, "claude-refresh");
  assert.equal(progress.secret.expiresAt, NOW + 55 * 60_000);

  assert.equal(mock.calls[0]?.url, ANTHROPIC_ENDPOINTS.token);
  assert.equal(mock.calls[0]?.init?.redirect, "error");
  const tokenBody = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<
    string,
    string
  >;

  assert.equal(tokenBody.code, "auth-code");
  assert.equal(tokenBody.code_verifier, start.privateState.verifier);
  assert.equal(tokenBody.state, start.privateState.state);
  const bootstrap = new URL(mock.calls[1]?.url ?? "");

  assert.equal(
    bootstrap.origin + bootstrap.pathname,
    ANTHROPIC_ENDPOINTS.bootstrap,
  );
  assert.equal(bootstrap.searchParams.get("entrypoint"), "cli");
  assert.equal(mock.calls[1]?.init?.redirect, "error");
});

test("Claude OAuth retains full callback URL compatibility", async () => {
  const mock = sequenceFetch([
    json({
      access_token: "claude-access",
      refresh_token: "claude-refresh",
      expires_in: 3600,
    }),
    json({
      oauth_account: {
        account_uuid: "account-uuid",
        account_email: "person@example.com",
        organization_uuid: "org-uuid",
      },
    }),
  ]);
  const adapter = createAnthropicProviderAdapter({
    fetch: mock.fetch,
    now: () => NOW,
  });
  const start = await adapter.startLogin();
  const callback = new URL(ANTHROPIC_ENDPOINTS.callback);

  callback.searchParams.set("code", "auth-code");
  callback.searchParams.set("state", String(start.privateState.state));
  const progress = await adapter.continueLogin(
    start.privateState,
    callback.toString(),
  );

  assert.equal(progress.kind, "complete");
  const tokenBody = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<
    string,
    string
  >;

  assert.equal(tokenBody.code, "auth-code");
  assert.equal(tokenBody.state, start.privateState.state);
});

test("Claude OAuth rejects a callback whose state does not match before fetching", async () => {
  let fetched = false;
  const adapter = createAnthropicProviderAdapter({
    fetch: (async () => {
      fetched = true;
      throw new Error("must not fetch");
    }) as typeof fetch,
    now: () => NOW,
  });
  const start = await adapter.startLogin();

  await assert.rejects(
    adapter.continueLogin(start.privateState, "code#wrong-state"),
    /state did not match/,
  );
  assert.equal(fetched, false);
});

test("Claude quota parsers normalize polling payloads and response headers", () => {
  const quota = parseAnthropicQuota(
    {
      five_hour: { utilization: 25, resets_at: "2026-08-12T15:00:00Z" },
      seven_day: { utilization: 95, resets_at: "2026-08-19T12:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 100,
          resets_at: "2026-08-18T12:00:00Z",
          scope: { model: { id: "claude-opus-4-8", display_name: "Opus" } },
        },
      ],
      extra_usage: { is_enabled: true, utilization: 4 },
    },
    NOW,
  );

  assert.deepEqual(
    quota.windows.map((window) => [
      window.id,
      window.usedFraction,
      window.status,
    ]),
    [
      ["five_hour", 0.25, "ok"],
      ["seven_day", 0.95, "warning"],
      ["weekly:claude-opus-4-8", 1, "exhausted"],
    ],
  );
  assert.equal(quota.metadata?.extraUsageEnabled, true);

  const fromHeaders = parseAnthropicQuotaHeaders(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.7",
      "anthropic-ratelimit-unified-5h-reset": "1786550400",
      "anthropic-ratelimit-unified-fallback": "available",
    }),
    NOW,
  );

  assert.equal(fromHeaders?.windows[0]?.usedFraction, 0.7);
  assert.equal(fromHeaders?.windows[0]?.resetsAt, 1_786_550_400_000);
  assert.equal(fromHeaders?.metadata?.fallbackAvailable, true);
});

test("Claude inference preparation targets only the fixed subscription endpoint", async () => {
  const adapter = createAnthropicProviderAdapter({
    now: () => NOW,
    randomUUID: () => "4bcc7dc4-a16b-4a35-b63b-a1e2da824d94",
  });
  const request: AnthropicMessagesRequest = {
    model: "anthropic/claude-sonnet-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  };
  const prepared = await adapter.prepareInference({
    request,
    upstreamModel: "claude-sonnet-4-6",
    publicModel: request.model,
    secret: {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "account" },
    signal: new AbortController().signal,
  });

  assert.equal(prepared.url, ANTHROPIC_ENDPOINTS.messages);
  assert.equal(prepared.protocol, "anthropic");
  assert.equal(prepared.init.redirect, "error");
  const headers = new Headers(prepared.init.headers);

  assert.equal(headers.get("authorization"), "Bearer token");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.match(String(prepared.init.body), /"model":"claude-sonnet-4-6"/);

  const count = await adapter.prepareTokenCount?.({
    request,
    upstreamModel: "claude-sonnet-4-6",
    publicModel: request.model,
    secret: {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: NOW + 60_000,
    },
    identity: { externalAccountId: "account" },
    signal: new AbortController().signal,
  });

  assert.equal(count?.url, ANTHROPIC_ENDPOINTS.countTokens);
  assert.equal(
    Object.hasOwn(JSON.parse(String(count?.init.body)), "max_tokens"),
    false,
  );
});

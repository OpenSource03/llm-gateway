import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthTokenSchema } from "@opensource03/llm-gateway-contracts";
import {
  createAnthropicProviderAdapter,
  parseAnthropicQuotaHeaders,
} from "./anthropic";
import { AnthropicAgentSdkTransport } from "./anthropic-agent-sdk";

test("token creation is bounded and strictly create-only", () => {
  const body = {
    provider: "anthropic",
    token: "synthetic-token-value",
    display_name: "Test",
  };
  assert.equal(createOAuthTokenSchema.parse(body).transport, "direct");
  for (const extra of [
    { account_id: crypto.randomUUID() },
    { refresh_token: "secret" },
    { token: "a\nb" },
    { token: "x".repeat(4097) },
    { provider: "openai-codex" },
  ])
    assert.equal(
      createOAuthTokenSchema.safeParse({ ...body, ...extra }).success,
      false,
    );
});

test("non-refreshable token never makes a refresh request", async () => {
  const adapter = createAnthropicProviderAdapter({
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
  });
  await assert.rejects(
    adapter.refresh({
      kind: "access-token",
      accessToken: "synthetic-token-value",
      expiresAt: null,
    }),
    /cannot be refreshed/,
  );
});

test("scoped rejected quota is retained without a utilization header", () => {
  const quota = parseAnthropicQuotaHeaders(
    new Headers({
      "anthropic-ratelimit-unified-7d_oi-status": "rejected",
      "anthropic-ratelimit-unified-7d_oi-reset": "1800000000",
    }),
    100,
  );
  assert.equal(quota?.windows[0].scope, "requested-model");
  assert.equal(quota?.windows[0].allowed, false);
  assert.equal(quota?.windows[0].resetsAt, 1800000000000);
  assert.equal(parseAnthropicQuotaHeaders(new Headers()), null);
});

test("SDK observations retain per-window time and never assign another model's scoped quota", async () => {
  const profileId = `gw-token-${crypto.randomUUID()}`;
  const sdk = new AnthropicAgentSdkTransport(
    {
      baseUrl: "http://127.0.0.1:3456",
      apiKey: "private-bridge-key",
      modelRewrites: [],
    },
    {
      fetch: async () =>
        Response.json({
          profile: profileId,
          buckets: [
            {
              type: "five_hour",
              utilization: 0.2,
              status: "allowed",
              observedAt: 2000,
              resetsAt: 1800000000000,
            },
            {
              type: "seven_day_overage_included",
              model: "claude-fable-test",
              utilization: 1,
              status: "rejected",
              observedAt: 1000,
            },
          ],
        }),
    },
  );
  const transport = { id: "agent-sdk", profileId, tokenBacked: true };
  const haiku = await sdk.tokenQuota(transport, "claude-haiku-test");
  assert.equal(haiku.windows.length, 1);
  assert.equal(haiku.windows[0].resetsAt, 1800000000000);
  const fable = await sdk.tokenQuota(transport, "claude-fable-test");
  assert.equal(fable.windows[1].observedAt, 1000);
});

test("SDK token credentials require a gateway-owned token profile", async () => {
  const sdk = new AnthropicAgentSdkTransport({
    baseUrl: "http://127.0.0.1:3456",
    apiKey: "private-bridge-key",
    modelRewrites: [],
  });
  const input = {
    request: {
      model: "claude-test",
      max_tokens: 1,
      messages: [{ role: "user" as const, content: "OK" }],
    },
    upstreamModel: "claude-test",
    publicModel: "anthropic/claude-test",
    identity: { externalAccountId: "local-profile" },
    signal: new AbortController().signal,
    transport: { id: "agent-sdk", profileId: "default", tokenBacked: true },
  };
  await assert.rejects(
    sdk.prepareInference(input),
    /credential is unavailable/,
  );
  await assert.rejects(
    sdk.prepareInference({
      ...input,
      secret: {
        kind: "access-token",
        accessToken: "synthetic-token-value",
        expiresAt: null,
      },
    }),
    /credential is unavailable/,
  );
  const result = await sdk.prepareInference({
    ...input,
    transport: {
      ...input.transport,
      profileId: `gw-token-${crypto.randomUUID()}`,
    },
    secret: {
      kind: "access-token",
      accessToken: "synthetic-token-value",
      expiresAt: null,
    },
  });
  assert.equal(
    new Headers(result.init.headers).get("x-llmgw-oauth-token"),
    "synthetic-token-value",
  );
  assert.equal(
    JSON.stringify(result.init.body).includes("synthetic-token-value"),
    false,
  );
});

test("quota probes use the measured minimal token profile for scoped models", async () => {
  const adapter = createAnthropicProviderAdapter();
  const prepared = await adapter.prepareQuotaProbe!({
    request: {
      model: "claude-fable-test",
      max_tokens: 100,
      messages: [{ role: "user", content: "ignored" }],
    },
    upstreamModel: "claude-fable-test",
    publicModel: "anthropic/claude-fable-test",
    secret: {
      kind: "access-token",
      accessToken: "synthetic-token-value",
      expiresAt: null,
    },
    identity: { externalAccountId: "gateway-token:test" },
    signal: new AbortController().signal,
  });
  assert.equal(prepared.url, "https://api.anthropic.com/v1/messages");
  assert.equal(
    new Headers(prepared.init.headers).get("anthropic-beta"),
    "oauth-2025-04-20",
  );
  const body = JSON.parse(prepared.init.body as string);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.thinking, undefined);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "quota" }]);
});

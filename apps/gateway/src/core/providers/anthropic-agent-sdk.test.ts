import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { CodexResponsesRequest } from "../wire/codex-responses";

import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicAgentSdkTransport,
  classifyAgentSdkFailure,
  parseAgentSdkModels,
  parseAgentSdkDefaultProfile,
  parseAgentSdkProfiles,
  parseAgentSdkQuota,
} from "./anthropic-agent-sdk";

const config = {
  baseUrl: "http://127.0.0.1:3456",
  apiKey: "test-agent-sdk-key-that-is-long-enough",
};
const identity = { externalAccountId: "account-1" };
const transport = { id: "agent-sdk", profileId: "work" };

test("Agent SDK discovery consumes the bridge catalog without a gateway model list", () => {
  const discovery = parseAgentSdkModels({
    object: "list",
    data: [
      {
        id: "claude-sonnet-5",
        display_name: "Claude Sonnet 5",
        context_window: 200_000,
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: true,
            types: { adaptive: { supported: true } },
          },
          effort: { supported: true, high: { supported: true } },
        },
      },
      {
        id: "claude-sonnet-4-6",
        display_name: "Old Sonnet",
      },
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
    ],
  });

  assert.deepEqual(
    discovery.models.map(({ upstreamId }) => upstreamId),
    ["claude-sonnet-5", "claude-opus-5"],
  );
  assert.deepEqual(discovery.models[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(discovery.models[0]?.reasoningEfforts, ["high"]);
});

test("Agent SDK quota and profile parsing stay scoped to the selected profile", () => {
  assert.deepEqual(
    parseAgentSdkProfiles({
      profiles: [
        {
          id: "work",
          email: "Operator@Example.Test",
          subscriptionType: "max",
          loggedIn: true,
        },
      ],
    }),
    [
      {
        id: "work",
        email: "operator@example.test",
        plan: "max",
        authenticated: true,
      },
    ],
  );
  const quota = parseAgentSdkQuota(
    {
      asOf: 123,
      profiles: [
        { id: "personal", windows: [{ type: "five_hour", utilization: 0.9 }] },
        {
          id: "work",
          fetchedAt: 456,
          windows: [{ type: "five_hour", utilization: 0.25, resetsAt: 999 }],
        },
      ],
    },
    "work",
  );

  assert.equal(quota.fetchedAt, 456);
  assert.equal(quota.windows[0]?.usedFraction, 0.25);
  assert.equal(quota.metadata?.profile, "work");
  assert.deepEqual(
    parseAgentSdkDefaultProfile({
      auth: { loggedIn: true, subscriptionType: "max" },
    }),
    { id: "default", plan: "max", authenticated: true },
  );
});

test("Agent SDK Responses forwarding uses one Anthropic passthrough conversion", async () => {
  const bridge = new AnthropicAgentSdkTransport(config);
  const request: CodexResponsesRequest = {
    model: "anthropic/claude-opus-5",
    instructions: "Be concise",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "Run a command",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    store: false,
    include: [],
  };
  const prepared = await bridge.prepareResponsesInference({
    request,
    upstreamModel: "claude-opus-5",
    publicModel: "anthropic/claude-opus-5",
    identity,
    transport,
    sessionId: "session-1",
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);
  const body = JSON.parse(String(prepared.init.body)) as Record<
    string,
    unknown
  >;

  assert.equal(prepared.url, "http://127.0.0.1:3456/v1/messages");
  assert.equal(headers.get("x-meridian-profile"), "work");
  assert.equal(headers.get("x-meridian-agent"), "codex");
  assert.equal(headers.get("authorization"), `Bearer ${config.apiKey}`);
  assert.equal(body.model, "claude-opus-5");
  assert.equal(headers.get("x-codex-session"), "session-1");
  assert.equal(
    (body.tools as Array<Record<string, unknown>>)[0]?.name,
    "mcp__codex__shell",
  );

  const response = await prepared.transformResponse(
    new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":1,"cache_read_input_tokens":2,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      { headers: { "content-type": "text/event-stream", server: "private" } },
    ),
  );

  assert.equal(response.headers.get("server"), null);
  assert.match(await response.text(), /response\.completed/);
});

test("Agent SDK Messages forwarding forces external tool passthrough", async () => {
  const bridge = new AnthropicAgentSdkTransport(config);
  const request: AnthropicMessagesRequest = {
    model: "anthropic/claude-opus-5",
    max_tokens: 1_024,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };
  const prepared = await bridge.prepareInference({
    request,
    upstreamModel: "claude-opus-5",
    publicModel: "anthropic/claude-opus-5",
    identity,
    transport,
    sessionId: "session-2",
    signal: new AbortController().signal,
  });
  const headers = new Headers(prepared.init.headers);

  assert.equal(headers.get("x-meridian-agent"), "passthrough");
  assert.equal(headers.get("x-litellm-session-id"), "session-2");
});

test("Agent SDK authentication failures never trigger direct OAuth refresh", () => {
  const failure = classifyAgentSdkFailure(401, new Headers());

  assert.equal(failure.reauthenticate, false);
  assert.equal(failure.retryable, true);
  assert.equal(failure.kind, "transient");
});

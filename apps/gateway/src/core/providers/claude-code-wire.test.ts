import type { AnthropicMessagesRequest } from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream } from "../wire/sse";

import {
  extractCch,
  signClaudeCodeRequestBody,
  xxhash64,
} from "./claude-code-cch";
import {
  rewriteClaudeCodeCountTokensRequest,
  rewriteClaudeCodeRequest,
  transformClaudeResponse,
} from "./claude-code-wire";

const CAPTURED_NATIVE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
  "fallback-credit-2026-06-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
].join(",");

const request: AnthropicMessagesRequest = {
  model: "public/claude",
  max_tokens: 512,
  messages: [
    { role: "user", content: "Run the tool" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "shell",
          input: { cmd: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "tool_reference", tool_name: "shell" }],
        },
      ],
    },
  ],
  tools: [
    {
      name: "shell",
      description: "Run a command",
      input_schema: { type: "object" },
    },
  ],
  tool_choice: { type: "tool", name: "shell" },
};

test("xxHash64 and Claude Code billing signatures are deterministic", () => {
  assert.equal(xxhash64(new Uint8Array()).toString(16), "ef46db3751d8e999");
  const unsigned =
    '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.247.f3e; cc_entrypoint=cli; cch=00000;"}],"messages":[]}';
  const signed = signClaudeCodeRequestBody(unsigned);

  assert.match(extractCch(signed) ?? "", /^[0-9a-f]{5}$/);
  assert.notEqual(extractCch(signed), "00000");
  assert.equal(signClaudeCodeRequestBody(signed), signed);
});

test("Claude Code wire rewrite signs the body and namespaces tools reversibly", () => {
  const rewritten = rewriteClaudeCodeRequest({
    request,
    upstreamModel: "claude-sonnet-4-6",
    identity: { externalAccountId: "acct-123" },
    accessToken: "oauth-token",
    sessionId: "4b38793e-2504-4ec0-a674-276855846461",
    requestId: "6c27c311-3207-4607-8650-e204a03391f8",
  });
  const body = JSON.parse(rewritten.body) as Record<string, any>;

  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.system[0].type, "text");
  assert.match(body.system[0].text, /cch=[0-9a-f]{5};/);
  assert.notEqual(extractCch(rewritten.body), "00000");
  assert.match(
    body.system[0].text,
    /cc_version=2\.1\.260\.f3e; cc_entrypoint=cli; cch=[0-9a-f]{5}; cc_prompt_id=[0-9a-f-]{36};/,
  );
  assert.doesNotMatch(
    body.system[0].text,
    /cc_prompt_id=4b38793e-2504-4ec0-a674-276855846461;/,
  );
  assert.equal(body.tools[0].name, "mcp__codex__shell");
  assert.equal(body.tool_choice.name, "mcp__codex__shell");
  assert.equal(body.messages[1].content[0].name, "mcp__codex__shell");
  assert.equal(
    body.messages[2].content[0].content[0].tool_name,
    "mcp__codex__shell",
  );
  assert.equal(rewritten.toolNames.get("mcp__codex__shell"), "shell");
  assert.deepEqual(body.diagnostics, {
    previous_message_id: null,
  });
  assert.deepEqual(Object.keys(body), [
    "model",
    "messages",
    "system",
    "tools",
    "tool_choice",
    "metadata",
    "max_tokens",
    "diagnostics",
  ]);
  assert.equal(rewritten.headers.get("authorization"), "Bearer oauth-token");
  assert.equal(rewritten.headers.get("accept"), "application/json");
  assert.equal(
    rewritten.headers.get("user-agent"),
    "claude-cli/2.1.260 (external, cli)",
  );
  assert.equal(rewritten.headers.get("x-stainless-package-version"), "0.112.1");
  assert.equal(rewritten.headers.get("x-stainless-runtime-version"), "v26.3.0");
  assert.equal(
    rewritten.headers.get("x-claude-code-session-id"),
    rewritten.sessionId,
  );
  assert.equal(rewritten.headers.get("anthropic-beta"), CAPTURED_NATIVE_BETAS);
  assert.deepEqual(JSON.parse(body.metadata.user_id), {
    device_id:
      body.metadata.user_id && JSON.parse(body.metadata.user_id).device_id,
    account_uuid: "acct-123",
    session_id: rewritten.sessionId,
  });
  assert.match(JSON.parse(body.metadata.user_id).device_id, /^[0-9a-f]{64}$/);
});

test("Claude wire preserves the captured native field order and automatic-tool omission", () => {
  const sessionId = "9e051b11-c811-4a88-8074-8a4a1c73f37a";
  const nativeShape = rewriteClaudeCodeRequest({
    request: {
      model: "public/claude",
      messages: [{ role: "user", content: "Use the available tool" }],
      system: "Portable harness instructions",
      tools: [
        {
          name: "mcp__capture__echo",
          input_schema: { type: "object" },
        },
      ],
      tool_choice: { type: "auto" },
      max_tokens: 64_000,
      thinking: { type: "adaptive" },
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      output_config: { effort: "medium" },
      stream: true,
    },
    upstreamModel: "claude-opus-5",
    identity: { externalAccountId: "acct-123" },
    accessToken: "oauth-token",
    sessionId,
    requestId: "c9b53074-6924-4263-88f6-4706baac6d99",
  });
  const body = JSON.parse(nativeShape.body) as Record<string, any>;

  assert.deepEqual(Object.keys(body), [
    "model",
    "messages",
    "system",
    "tools",
    "metadata",
    "max_tokens",
    "thinking",
    "context_management",
    "output_config",
    "diagnostics",
    "stream",
  ]);
  assert.equal(Object.hasOwn(body, "tool_choice"), false);
  assert.equal(body.tools[0].name, "mcp__capture__echo");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.context_management, {
    edits: [{ type: "clear_thinking_20251015", keep: "all" }],
  });
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.deepEqual(body.diagnostics, { previous_message_id: null });
  assert.equal(
    nativeShape.headers.get("anthropic-beta"),
    CAPTURED_NATIVE_BETAS,
  );
  assert.equal(nativeShape.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(
    nativeShape.headers.get("anthropic-dangerous-direct-browser-access"),
    "true",
  );
  assert.equal(nativeShape.headers.get("accept"), "application/json");
  assert.equal(nativeShape.headers.get("x-app"), "cli");
  assert.equal(nativeShape.headers.get("x-stainless-lang"), "js");
  assert.equal(nativeShape.headers.get("x-stainless-runtime"), "node");
  assert.equal(nativeShape.headers.get("x-stainless-retry-count"), "0");
  assert.equal(nativeShape.headers.get("x-stainless-timeout"), "600");
  assert.equal(nativeShape.headers.get("x-claude-code-session-id"), sessionId);
  assert.equal(
    nativeShape.headers.get("x-client-request-id"),
    "c9b53074-6924-4263-88f6-4706baac6d99",
  );
});

test("Claude prompt identity is stable per session and separate from the public session id", () => {
  const sessionId = "799e06c0-a253-4eea-840e-fc61ae79fd50";
  const rewrite = (requestId: string, nextSessionId = sessionId) =>
    rewriteClaudeCodeRequest({
      request: {
        model: "public/claude",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 128,
      },
      upstreamModel: "claude-opus-5",
      identity: { externalAccountId: "acct-123" },
      accessToken: "oauth-token",
      sessionId: nextSessionId,
      requestId,
    });
  const promptId = (body: string): string => {
    const parsed = JSON.parse(body) as Record<string, any>;
    const match = /cc_prompt_id=([0-9a-f-]{36});/.exec(parsed.system[0].text);

    assert.ok(match);

    return match[1];
  };
  const first = promptId(rewrite("9104f09c-b64c-4d70-b028-f4fa1409bb01").body);
  const second = promptId(rewrite("6905a7ad-f28a-49c9-a215-0b7aa8740c9b").body);
  const differentSession = promptId(
    rewrite(
      "d073b804-aaad-48bc-821d-27bfcb6f96c7",
      "e0cc01c9-f764-477a-8d76-16b170ba455c",
    ).body,
  );

  assert.equal(first, second);
  assert.notEqual(first, sessionId);
  assert.notEqual(first, differentSession);
});

test("Claude token-count rewrite omits generation-only fields and remains signed", () => {
  const rewritten = rewriteClaudeCodeCountTokensRequest({
    request: { ...request, stream: true, temperature: 0.2 },
    upstreamModel: "claude-sonnet-4-6",
    identity: { externalAccountId: "acct-123" },
    accessToken: "oauth-token",
    requestId: "21deea6f-d567-4f8f-bc1f-610581796f6a",
  });
  const body = JSON.parse(rewritten.body) as Record<string, unknown>;

  assert.equal(Object.hasOwn(body, "max_tokens"), false);
  assert.equal(Object.hasOwn(body, "stream"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
  assert.match(extractCch(rewritten.body) ?? "", /^[0-9a-f]{5}$/);
});

test("Claude rewrite forwards reviewed parity fields and drops unknown features", () => {
  const rewritten = rewriteClaudeCodeRequest({
    request: {
      ...request,
      unreviewed_provider_feature: { resource_id: "shared-resource" },
      speed: "fast",
      context_management: {
        edits: [
          { type: "clear_thinking_20251015", keep: "all" },
          { type: "compact_20260112" },
        ],
      },
      output_config: {
        effort: "high",
        format: { type: "unadvertised_structured_output" },
      },
    },
    upstreamModel: "claude-sonnet-4-6",
    identity: { externalAccountId: "acct-123" },
    accessToken: "oauth-token",
    requestId: "990fb091-a46b-4477-9091-ef89d40418e2",
  });
  const body = JSON.parse(rewritten.body) as Record<string, unknown>;
  const beta = rewritten.headers.get("anthropic-beta") ?? "";

  assert.equal(Object.hasOwn(body, "unreviewed_provider_feature"), false);
  assert.equal(Object.hasOwn(body, "speed"), false);
  assert.deepEqual(body.context_management, {
    edits: [
      { type: "clear_thinking_20251015", keep: "all" },
      { type: "compact_20260112" },
    ],
  });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.doesNotMatch(beta, /fast-mode/);
  assert.match(beta, /oauth-2025-04-20/);
  assert.match(beta, /effort-2025-11-24/);
  assert.match(beta, /context-management-2025-06-27/);
  assert.match(beta, /compact-2026-01-12/);
});

test("Claude response conversion restores original tool names for JSON and SSE", async () => {
  const names = new Map([["mcp_Shell", "shell"]]);
  const json = await transformClaudeResponse(
    new Response(
      JSON.stringify({ content: [{ type: "tool_use", name: "mcp_Shell" }] }),
      {
        headers: { "content-type": "application/json" },
      },
    ),
    false,
    names,
  );

  assert.equal(((await json.json()) as any).content[0].name, "shell");

  const sse = await transformClaudeResponse(
    new Response(
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Shell"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
    true,
    names,
  );

  assert.match(await sse.text(), /"name":"shell"/);
});

test("Claude stream errors expose only the fixed public error payload", async () => {
  const secret = "Bearer upstream-secret-token";
  const fixtures = [
    `event: error\ndata: raw failure ${secret}\n\n`,
    `data: ${JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: `provider rejected ${secret}`,
        internal_request_id: "provider-request-secret",
      },
    })}\n\n`,
  ];

  for (const fixture of fixtures) {
    const response = await transformClaudeResponse(
      new Response(
        `${fixture}event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "must not follow an error" },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
      true,
      new Map(),
    );
    const frames = [];

    for await (const frame of parseSseStream(response.body!)) {
      frames.push({
        event: frame.event,
        data: JSON.parse(frame.data) as Record<string, unknown>,
      });
    }

    assert.deepEqual(frames, [
      {
        event: "error",
        data: {
          type: "error",
          error: {
            type: "api_error",
            message: "Upstream provider request failed",
          },
        },
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(frames),
      /upstream-secret|provider-request/,
    );
  }
});

test("Claude response conversion does not rewrite unrelated nested name fields", async () => {
  const response = await transformClaudeResponse(
    new Response(
      JSON.stringify({
        content: [
          {
            type: "tool_use",
            name: "mcp_Shell",
            input: { name: "mcp_Shell", nested: { name: "mcp_Shell" } },
          },
        ],
        metadata: { name: "mcp_Shell" },
      }),
    ),
    false,
    new Map([["mcp_Shell", "shell"]]),
  );
  const body = (await response.json()) as any;

  assert.equal(body.content[0].name, "shell");
  assert.equal(body.content[0].input.name, "mcp_Shell");
  assert.equal(body.content[0].input.nested.name, "mcp_Shell");
  assert.equal(body.metadata.name, "mcp_Shell");
});

test("Claude request rewrite rejects tool namespace collisions", () => {
  assert.throws(
    () =>
      rewriteClaudeCodeRequest({
        request: {
          model: "public/claude",
          max_tokens: 100,
          messages: [{ role: "user", content: "Use a tool" }],
          tools: [
            { name: "a/b", input_schema: { type: "object" } },
            { name: "a?b", input_schema: { type: "object" } },
          ],
        },
        upstreamModel: "claude-sonnet-4-6",
        identity: { externalAccountId: "acct-123" },
        accessToken: "oauth-token",
        requestId: "8680a702-189a-45a9-b55d-0eae4250476b",
      }),
    /collide after namespacing/,
  );
});

test("Claude stream honors backpressure and propagates downstream cancellation", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  let cancelReason: unknown;
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const upstream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
          ),
        );
      },
      cancel(reason) {
        cancelReason = reason;
        resolveCancelled();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await transformClaudeResponse(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    true,
    new Map(),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pulls <= 1, `transform prefetched ${pulls} upstream chunks`);
  const reader = response.body!.getReader();
  const first = await reader.read();

  assert.equal(first.done, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pulls <= 2, `transform ignored backpressure after ${pulls} pulls`);
  await reader.cancel("Claude client disconnected");
  await Promise.race([
    cancelled,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("upstream cancellation timed out")),
        250,
      ),
    ),
  ]);
  assert.equal(cancelReason, "Claude client disconnected");
});

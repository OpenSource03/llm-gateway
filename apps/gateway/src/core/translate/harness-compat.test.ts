import assert from "node:assert/strict";
import test from "node:test";
import type { CodexResponsesRequest } from "../wire/codex-responses";
import { parseSseStream, streamFromStrings } from "../wire/sse";
import { codexToAnthropic } from "./codex-to-anthropic";
import { anthropicSseToCodexResponses } from "./anthropic-to-codex";

const request = (
  input: CodexResponsesRequest["input"] = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Discover the issue reader" }],
    },
  ],
): CodexResponsesRequest => ({
  model: "provider/model",
  instructions: "Preserve client instructions",
  input,
  tools: [
    {
      type: "tool_search",
      execution: "client",
      description: "Discover MCP tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  store: false,
  stream: true,
  include: [],
});
const options = { model: "provider-model", maxOutputTokens: 1024 };
const frame = (data: Record<string, unknown>) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

test("client tool search survives discovery, results, and a loaded MCP call", async () => {
  const first = codexToAnthropic(request(), options);
  const search = first.request.tools![0]!;
  assert.deepEqual(search.input_schema.required, ["query"]);
  const upstream = streamFromStrings([
    frame({ type: "message_start", message: { id: "search-response" } }),
    frame({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "search-call",
        name: search.name,
        input: {},
      },
    }),
    frame({
      type: "content_block_delta",
      index: 0,
      delta: { partial_json: '{"query":"issue reader"}' },
    }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    frame({ type: "message_stop" }),
  ]);
  let call: Record<string, unknown> | undefined;
  for await (const event of parseSseStream(
    anthropicSseToCodexResponses(upstream, {
      publicModel: "provider/model",
      toolIdentities: first.toolIdentities,
    }),
  )) {
    if (event.event === "response.output_item.done")
      call = JSON.parse(event.data).item;
  }
  assert.equal(call?.type, "tool_search_call");
  assert.equal(call?.execution, "client");
  assert.deepEqual(call?.arguments, { query: "issue reader" });
  const loaded = {
    type: "namespace",
    name: "mcp__test",
    tools: [
      {
        type: "function",
        name: "read_issue",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
  };
  const second = codexToAnthropic(
    request([
      call!,
      {
        type: "tool_search_output",
        execution: "client",
        call_id: "search-call",
        tools: [loaded],
      },
      {
        type: "function_call",
        call_id: "read-call",
        namespace: "mcp__test",
        name: "read_issue",
        arguments: '{"id":"TEST-1"}',
      },
      {
        type: "function_call_output",
        call_id: "read-call",
        output: "synthetic result",
      },
    ]),
    options,
  );
  assert.equal(second.request.tools!.length, 2);
  assert.ok(
    [...second.toolIdentities.values()].some(
      (t) => t.namespace === "mcp__test" && t.name === "read_issue",
    ),
  );
  const messages = JSON.stringify(second.request.messages);
  assert.match(messages, /search-call/);
  assert.match(messages, /synthetic result/);
  assert.throws(
    () =>
      codexToAnthropic(
        { ...request(), tools: [{ type: "tool_search", execution: "server" }] },
        options,
      ),
    /client-executed/,
  );
});

for (const stopReason of ["end_turn", "tool_use", "max_tokens"]) {
  test(`text streams before completion and final phase follows ${stopReason}`, async () => {
    const upstream = streamFromStrings([
      frame({ type: "message_start", message: { id: "text-response" } }),
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { text: "Synthetic text" },
      }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: stopReason } }),
      frame({ type: "message_stop" }),
    ]);
    const events = [];
    for await (const event of parseSseStream(
      anthropicSseToCodexResponses(upstream, {
        publicModel: "provider/model",
        toolIdentities: new Map(),
      }),
    ))
      events.push(JSON.parse(event.data));
    assert.ok(
      events.findIndex((e) => e.type === "response.output_text.delta") <
        events.findIndex((e) => e.type === "response.output_item.done"),
    );
    assert.equal(
      events.find((e) => e.type === "response.output_item.done").item.phase,
      stopReason === "end_turn" ? "final_answer" : "commentary",
    );
  });
}

test("code mode JavaScript round-trips byte-for-byte through custom tool lowering", async () => {
  const script =
    "const matches = ALL_TOOLS.filter(t => /test/.test(t.name)); text(matches);";
  const source = {
    ...request(),
    tools: [
      {
        type: "namespace",
        name: "functions",
        tools: [
          { type: "custom", name: "exec", description: "Execute JavaScript" },
        ],
      },
    ],
    input: [
      {
        type: "custom_tool_call",
        namespace: "functions",
        name: "exec",
        call_id: "exec-call",
        input: script,
      },
      { type: "custom_tool_call_output", call_id: "exec-call", output: "[]" },
    ],
  };
  const converted = codexToAnthropic(source, options);
  assert.ok(
    JSON.stringify(converted.request.messages).includes(
      JSON.stringify(script).slice(1, -1),
    ),
  );
  const wireName = converted.request.tools![0]!.name;
  const upstream = streamFromStrings([
    frame({ type: "message_start", message: { id: "exec-response" } }),
    frame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "exec-next", name: wireName },
    }),
    frame({
      type: "content_block_delta",
      index: 0,
      delta: { partial_json: JSON.stringify({ input: script }) },
    }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    frame({ type: "message_stop" }),
  ]);
  for await (const event of parseSseStream(
    anthropicSseToCodexResponses(upstream, {
      publicModel: "provider/model",
      toolIdentities: converted.toolIdentities,
    }),
  )) {
    if (event.event !== "response.output_item.done") continue;
    const item = JSON.parse(event.data).item;
    assert.equal(item.type, "custom_tool_call");
    assert.equal(item.namespace, "functions");
    assert.equal(item.input, script);
  }
});

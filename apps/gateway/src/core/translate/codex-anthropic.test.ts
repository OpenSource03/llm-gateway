import assert from "node:assert/strict";
import test from "node:test";

import { streamFromStrings, parseSseStream } from "../wire/sse";

import { anthropicSseToCodexResponses } from "./anthropic-to-codex";
import { codexToAnthropic } from "./codex-to-anthropic";

test("Codex requests map messages, namespace functions, and custom tools to Claude", () => {
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-sonnet-4-6",
      instructions: "Provider-neutral developer instructions",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix it" }],
        },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [
                {
                  type: "function",
                  name: "read_file",
                  description: "Read a file",
                  strict: false,
                  parameters: { type: "object", properties: {} },
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
            },
          ],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    },
    { model: "claude-sonnet-4-6", maxOutputTokens: 64_000 },
  );

  assert.equal(converted.request.model, "claude-sonnet-4-6");
  assert.deepEqual(converted.request.system, [
    {
      type: "text",
      text: "Provider-neutral developer instructions",
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.equal(converted.request.messages[0]?.role, "user");
  assert.equal(converted.request.tools?.length, 2);
  assert.equal(converted.request.tools?.[0]?.cache_control, undefined);
  assert.deepEqual(converted.request.tools?.[1]?.cache_control, {
    type: "ephemeral",
  });
  assert.deepEqual(converted.request.thinking, { type: "adaptive" });
  assert.deepEqual(converted.request.output_config, { effort: "high" });
  assert.deepEqual(converted.request.context_management, {
    edits: [{ type: "clear_thinking_20251015", keep: "all" }],
  });
  assert.deepEqual(converted.toolIdentities.get("mcp__functions__read_file"), {
    kind: "function",
    name: "read_file",
    namespace: "functions",
  });
  assert.deepEqual(converted.toolIdentities.get("mcp__functions__exec"), {
    kind: "custom",
    name: "exec",
    namespace: "functions",
  });
});

test("Claude translation guards assistant-tail continuation requests", () => {
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-opus-5",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Start" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Partial answer" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    },
    { model: "claude-opus-5", maxOutputTokens: 64_000 },
  );

  assert.deepEqual(converted.request.messages.at(-1), {
    role: "user",
    content: "(continue)",
  });
});

test("Claude translation preserves structured tool-result images safely", () => {
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-opus-5",
      instructions: "",
      input: [
        {
          type: "function_call",
          call_id: "call-image",
          name: "view_image",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-image",
          output: [
            { type: "input_text", text: "Screenshot" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "original",
            },
            {
              type: "encrypted_content",
              encrypted_content: "opaque-provider-payload",
            },
          ],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    },
    { model: "claude-opus-5", maxOutputTokens: 64_000 },
  );
  const result = (
    converted.request.messages[1]?.content as Array<Record<string, unknown>>
  )[0];

  assert.equal(result.type, "tool_result");
  assert.deepEqual(result.content, [
    { type: "text", text: "Screenshot" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "aGVsbG8=",
      },
    },
    { type: "text", text: "[encrypted content omitted]" },
  ]);
});

test("Claude translation renders agent messages and empty tool output", () => {
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-opus-5",
      instructions: "",
      input: [
        {
          type: "function_call",
          call_id: "call-empty",
          name: "exec",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-empty",
          output: "",
        },
        {
          type: "agent_message",
          content: [
            { type: "input_text", text: "Worker finished" },
            {
              type: "encrypted_content",
              encrypted_content: "opaque-agent-payload",
            },
          ],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    },
    { model: "claude-opus-5", maxOutputTokens: 64_000 },
  );
  const userBlocks = converted.request.messages[1]?.content as Array<
    Record<string, unknown>
  >;

  assert.deepEqual(userBlocks, [
    {
      type: "tool_result",
      tool_use_id: "call-empty",
      content: "(empty tool output)",
    },
    { type: "text", text: "Worker finished" },
    { type: "text", text: "[encrypted sub-agent content omitted]" },
  ]);
});

test("Claude translation rejects non-object function arguments", () => {
  assert.throws(
    () =>
      codexToAnthropic(
        {
          model: "anthropic/claude-opus-5",
          instructions: "",
          input: [
            {
              type: "function_call",
              call_id: "call-invalid",
              name: "exec",
              arguments: '"not-an-object"',
            },
          ],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: [],
        },
        { model: "claude-opus-5", maxOutputTokens: 64_000 },
      ),
    /must encode an object/,
  );
});

test("Claude translation keeps native MCP names bounded and reversible", () => {
  const namespace = "capture tools";
  const firstName = "read_".repeat(30);
  const secondName = `${"read_".repeat(29)}other`;
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-opus-5",
      instructions: "",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: namespace,
              tools: [
                {
                  type: "function",
                  name: firstName,
                  parameters: { type: "object" },
                },
                {
                  type: "function",
                  name: secondName,
                  parameters: { type: "object" },
                },
              ],
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use a tool" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    },
    { model: "claude-opus-5", maxOutputTokens: 64_000 },
  );
  const wireNames = converted.request.tools?.map((tool) => tool.name) ?? [];

  assert.equal(wireNames.length, 2);
  assert.equal(new Set(wireNames).size, 2);
  for (const wireName of wireNames) {
    assert.match(wireName, /^mcp__capture_tools__/);
    assert.equal(wireName.split("__").slice(2).join("__").length, 128);
  }
  assert.deepEqual(converted.toolIdentities.get(wireNames[0]!), {
    kind: "function",
    name: firstName,
    namespace,
  });
  assert.deepEqual(converted.toolIdentities.get(wireNames[1]!), {
    kind: "function",
    name: secondName,
    namespace,
  });
});

test("Claude SSE maps text, tool calls, and usage to Codex Responses events", async () => {
  const upstream = streamFromStrings([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_claude","usage":{"input_tokens":10,"cache_read_input_tokens":2}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"codex_tool_0","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const translated = anthropicSseToCodexResponses(upstream, {
    publicModel: "anthropic/claude-sonnet-4-6",
    toolIdentities: new Map([
      [
        "codex_tool_0",
        {
          kind: "function" as const,
          name: "read_file",
          namespace: "functions",
        },
      ],
    ]),
  });
  const events: Array<{ event?: string; data: Record<string, unknown> }> = [];

  for await (const frame of parseSseStream(translated)) {
    events.push({ event: frame.event, data: JSON.parse(frame.data) });
  }
  assert.equal(events[0]?.event, "response.created");
  assert.equal(
    events.some((event) => event.event === "response.output_text.delta"),
    true,
  );
  const tool = events.find(
    (event) => event.event === "response.output_item.done",
  )?.data.item as Record<string, unknown>;

  assert.equal(tool.type, "message");
  const functionCall = events
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => event.data.item as Record<string, unknown>)
    .find((item) => item.type === "function_call");

  assert.equal(functionCall?.name, "read_file");
  assert.equal(functionCall?.namespace, "functions");
  assert.equal(functionCall?.arguments, '{"path":"a.ts"}');
  const completed = events.find((event) => event.event === "response.completed")
    ?.data.response as {
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  assert.equal(completed.usage?.input_tokens, 12);
  assert.equal(completed.usage?.output_tokens, 6);
});

test("Claude collaboration calls declare their message argument plaintext", async () => {
  const upstream = streamFromStrings([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_claude","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_spawn","name":"codex_tool_0","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"message\\":\\"Child task\\",\\"task_name\\":\\"worker\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const translated = anthropicSseToCodexResponses(upstream, {
    publicModel: "anthropic/claude-opus-5",
    toolIdentities: new Map([
      [
        "codex_tool_0",
        {
          kind: "function" as const,
          name: "spawn_agent",
          namespace: "collaboration",
        },
      ],
    ]),
  });
  const items: Array<Record<string, unknown>> = [];

  for await (const frame of parseSseStream(translated)) {
    if (frame.event !== "response.output_item.done") continue;
    const data = JSON.parse(frame.data) as { item: Record<string, unknown> };

    items.push(data.item);
  }

  assert.deepEqual(items[0]?.encrypted_function_args, []);
});

test("Responses without thinking omit the thinking-clear edit rejected by Claude", () => {
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-haiku-test",
      instructions: "",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "OK" }],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    },
    { model: "claude-haiku-test", maxOutputTokens: 16 },
  );
  assert.equal(converted.request.thinking, undefined);
  assert.equal(converted.request.context_management, undefined);
});

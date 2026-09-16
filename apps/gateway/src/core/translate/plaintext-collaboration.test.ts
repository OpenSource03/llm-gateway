import assert from "node:assert/strict";
import test from "node:test";
import type { CodexResponsesRequest } from "../wire/codex-responses";
import {
  preparePlaintextCollaboration,
  restorePlaintextCollaborationItem,
} from "./plaintext-collaboration";
import { sanitizeCodexResponsesStream } from "./sanitize-codex-responses";
import { streamFromStrings, parseSseStream } from "../wire/sse";

type MessageTool = {
  name: string;
  parameters: { properties: { message: { encrypted?: boolean } } };
};

const request = (): CodexResponsesRequest => ({
  model: "gpt-test",
  instructions: "Keep client instructions",
  input: [],
  tools: [
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", encrypted: true },
              model: { type: "string" },
            },
          },
        },
        {
          type: "function",
          name: "wait_agent",
          parameters: { type: "object" },
        },
      ],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  store: false,
  stream: true,
  include: [],
});

test("delegation disables message encryption in the schema and declares plaintext delivery", () => {
  const source = request();
  const prepared = preparePlaintextCollaboration(source);
  const spawn = prepared.request.tools![1]! as MessageTool;
  assert.match(spawn.name, /^llmgw_delegate_/);
  assert.equal(spawn.parameters.properties.message.encrypted, undefined);
  assert.equal(
    (source.tools![0]!.tools as MessageTool[])[0]!.parameters.properties.message
      .encrypted,
    true,
  );
  assert.equal(prepared.request.instructions, source.instructions);
  const argumentsText = JSON.stringify({
    message: "Reply TEST_OK",
    model: "anthropic/claude-test",
  });
  const restored = restorePlaintextCollaborationItem(
    {
      type: "function_call",
      name: spawn.name,
      call_id: "call-1",
      arguments: argumentsText,
    },
    prepared.plaintextTools,
  );
  assert.equal(restored.arguments, argumentsText);
  assert.equal(restored.name, "spawn_agent");
  assert.equal(restored.namespace, "collaboration");
  assert.deepEqual(restored.encrypted_function_args, []);
  const replay = preparePlaintextCollaboration({
    ...source,
    input: [restored],
  });
  assert.equal(replay.request.input[0]!.name, spawn.name);
  assert.equal(replay.request.input[0]!.namespace, undefined);
  assert.equal(replay.request.input[0]!.arguments, argumentsText);
});

test("deferred declarations are normalized without touching history or unrelated schemas", () => {
  const source = request();
  const encrypted = {
    type: "function_call",
    namespace: "collaboration",
    name: "spawn_agent",
    arguments: '{"message":"opaque"}',
    call_id: "old",
  };
  source.input = [{ type: "additional_tools", tools: source.tools }, encrypted];
  source.tools = [
    {
      type: "function",
      name: "other_tool",
      parameters: {
        properties: { message: { type: "string", encrypted: true } },
      },
    },
  ];
  const prepared = preparePlaintextCollaboration(source);
  assert.equal(prepared.request.input[1], encrypted);
  assert.deepEqual(prepared.request.tools![0], source.tools![0]);
  assert.ok(prepared.plaintextTools.has("llmgw_delegate_spawn_agent"));
  assert.throws(
    () =>
      restorePlaintextCollaborationItem(
        {
          type: "function_call",
          name: "llmgw_delegate_spawn_agent",
          encrypted_function_args: ["message"],
        },
        prepared.plaintextTools,
      ),
    /encrypted/,
  );
});

test("SSE declares plaintext consistently on streamed and completed output and fails closed on encryption", async () => {
  const { plaintextTools } = preparePlaintextCollaboration(request());
  const item = {
    type: "function_call",
    name: "llmgw_delegate_spawn_agent",
    arguments: '{"message":"TEST_OK"}',
  };
  const frames = [
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item] } },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const events = [];
  for await (const e of parseSseStream(
    sanitizeCodexResponsesStream(streamFromStrings(frames), plaintextTools),
  ))
    events.push(JSON.parse(e.data));
  assert.deepEqual(events[0].item.encrypted_function_args, []);
  assert.deepEqual(events[1].response.output[0], events[0].item);
  for (const encrypted_function_args of [["message"], "malformed"]) {
    const invalid = {
      type: "response.output_item.done",
      item: { ...item, encrypted_function_args },
    };
    const text = await new Response(
      sanitizeCodexResponsesStream(
        streamFromStrings([`data: ${JSON.stringify(invalid)}\n\n`]),
        plaintextTools,
      ),
    ).text();
    assert.match(text, /response.failed/);
    assert.doesNotMatch(text, /TEST_OK/);
  }
});

test("wire aliases do not collide with caller-owned functions", () => {
  const source = request();
  const unrelated = {
    type: "function",
    name: "llmgw_delegate_spawn_agent",
    parameters: { type: "object" },
  };
  source.tools!.push(unrelated);
  const prepared = preparePlaintextCollaboration(source);
  assert.ok(prepared.plaintextTools.has("llmgw_delegate_spawn_agent_1"));
  assert.ok(!prepared.plaintextTools.has(unrelated.name));
  const output = {
    type: "function_call",
    name: unrelated.name,
    arguments: "{}",
  };
  assert.equal(
    restorePlaintextCollaborationItem(output, prepared.plaintextTools),
    output,
  );
});

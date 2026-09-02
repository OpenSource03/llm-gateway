import type { CodexResponsesRequest } from "../wire/codex-responses";

import assert from "node:assert/strict";
import test from "node:test";

import { lowerPlaintextCodexAgentMessages } from "./codex-agent-messages";

const request = (content: Array<Record<string, unknown>>) =>
  ({
    model: "gpt-5.6-sol",
    instructions: "",
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content,
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  }) satisfies CodexResponsesRequest;

test("lowers plaintext agent tasks to portable user messages", () => {
  const source = request([
    {
      type: "input_text",
      text: "Message Type: NEW_TASK\nPayload:\nDo the work",
    },
  ]);
  const lowered = lowerPlaintextCodexAgentMessages(source);

  assert.notEqual(lowered, source);
  assert.deepEqual(lowered.input, [
    {
      type: "message",
      role: "user",
      content: source.input[0]?.content,
    },
  ]);
  assert.equal(source.input[0]?.type, "agent_message");
});

test("preserves opaque provider-encrypted agent tasks", () => {
  const source = request([
    { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
    { type: "encrypted_content", encrypted_content: "opaque-provider-data" },
  ]);

  assert.equal(lowerPlaintextCodexAgentMessages(source), source);
});

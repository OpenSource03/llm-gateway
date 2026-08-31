import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "../wire/sse";

import {
  prepareXaiCodexCompatibilityRequest,
  restoreXaiCodexCustomToolStream,
} from "./xai-codex-compat";

test("lowers xAI custom definitions and replay items without mutating input", () => {
  const request = {
    model: "xai/grok-4.5",
    instructions: "",
    input: [
      {
        type: "custom_tool_call",
        id: "item-1",
        call_id: "call-1",
        name: "exec",
        input: "ls -la",
        status: "completed",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call-1",
        name: "exec",
        output: "done",
      },
    ],
    tools: [
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
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false as const,
    stream: true as const,
    include: [],
  };
  const before = structuredClone(request);
  const compatibility = prepareXaiCodexCompatibilityRequest(request);
  const tool = compatibility.request.tools?.[0];

  assert.equal(tool?.type, "function");
  assert.deepEqual(tool?.parameters, {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "Raw freeform input for this tool.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  });
  assert.deepEqual(compatibility.request.input, [
    {
      type: "function_call",
      id: "item-1",
      call_id: "call-1",
      name: "exec",
      arguments: '{"input":"ls -la"}',
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      name: "exec",
      output: "done",
    },
  ]);
  assert.equal(compatibility.customTools.has("\u0000exec"), true);
  assert.deepEqual(request, before);
});

test("rejects ambiguous xAI custom and function tool identities", () => {
  assert.throws(
    () =>
      prepareXaiCodexCompatibilityRequest({
        model: "xai/grok-4.5",
        instructions: "",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Run it" }],
          },
        ],
        tools: [
          { type: "function", name: "exec", parameters: {} },
          {
            type: "custom",
            name: "exec",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: "start: /.+/",
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        stream: true,
        include: [],
      }),
    /cannot disambiguate/,
  );
});

test("normalizes xAI live search and never widens cached-only search", () => {
  const live = prepareXaiCodexCompatibilityRequest({
    model: "xai/grok-4.5",
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Search" }],
      },
    ],
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: "high",
        filters: { allowed_domains: ["x.ai"] },
        user_location: { type: "approximate", country: "RS" },
        search_content_types: ["text", "image"],
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  });

  assert.deepEqual(live.request.tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["x.ai"] },
      user_location: { type: "approximate", country: "RS" },
      search_content_types: ["text", "image"],
      enable_image_search: true,
    },
  ]);
  assert.equal(live.request.tool_choice, "required");

  const cachedOnly = prepareXaiCodexCompatibilityRequest({
    model: "xai/grok-4.5",
    instructions: "",
    input: [
      {
        type: "additional_tools",
        tools: [{ type: "web_search", external_web_access: false }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Search" }],
      },
    ],
    tools: [{ type: "web_search", external_web_access: false }],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  });

  assert.equal(cachedOnly.request.tools, undefined);
  assert.deepEqual(cachedOnly.request.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Search" }],
    },
  ]);
  assert.equal(cachedOnly.request.tool_choice, "none");
});

test("restores lowered xAI function output as a Codex custom tool call", async () => {
  const upstream = streamFromStrings([
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"exec","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"input\\":\\"ls\\"}"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"exec","arguments":"{\\"input\\":\\"ls\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[{"type":"function_call","id":"item-1","call_id":"call-1","name":"exec","arguments":"{\\"input\\":\\"ls\\"}"}]}}\n\n',
  ]);
  const restored = restoreXaiCodexCustomToolStream(
    upstream,
    new Set(["\u0000exec"]),
  );
  const frames: Array<{ event?: string; data: Record<string, unknown> }> = [];

  for await (const frame of parseSseStream(restored)) {
    frames.push({ event: frame.event, data: JSON.parse(frame.data) });
  }

  assert.deepEqual(
    frames.map((frame) => frame.event),
    ["response.output_item.done", "response.completed"],
  );
  assert.deepEqual(frames[0]?.data.item, {
    type: "custom_tool_call",
    id: "item-1",
    call_id: "call-1",
    name: "exec",
    input: "ls",
    status: "completed",
  });
  const completed = frames[1]?.data.response as {
    output: Array<Record<string, unknown>>;
  };

  assert.equal(completed.output[0]?.type, "custom_tool_call");
  assert.equal(completed.output[0]?.input, "ls");
});

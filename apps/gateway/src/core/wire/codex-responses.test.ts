import assert from "node:assert/strict";
import test from "node:test";

import {
  codexGatewayModelId,
  parseCodexResponsesRequest,
} from "./codex-responses";

const validRequest = () => ({
  model: "openai/gpt-5.6-luna",
  input: [
    {
      type: "additional_tools",
      id: "at_fixture",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
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
        },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the test" }],
      internal_chat_message_metadata_passthrough: { secret: "strip-me" },
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "session-fixture",
  text: { verbosity: "low" },
  client_metadata: { thread_id: "thread-fixture" },
});

test("reconstructs the current Codex Responses request and strips internal metadata", () => {
  const request = parseCodexResponsesRequest(validRequest());

  assert.equal(request.model, "openai/gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.input[0]?.type, "additional_tools");
  assert.equal(
    "internal_chat_message_metadata_passthrough" in request.input[1]!,
    false,
  );
  assert.deepEqual(request.reasoning, {
    effort: "medium",
    summary: "auto",
    context: "all_turns",
  });
});

test("accepts Astra ultra reasoning effort", () => {
  const request = parseCodexResponsesRequest({
    ...validRequest(),
    model: "gpt-6-astra",
    reasoning: { effort: "ultra", summary: "auto" },
  });

  assert.deepEqual(request.reasoning, { effort: "ultra", summary: "auto" });
});

test("accepts large inline screenshots while retaining image and text bounds", () => {
  const imageUrl = "data:image/png;base64," + "A".repeat(3 * 1024 * 1024);
  const input = [
    {
      type: "custom_tool_call_output",
      call_id: "screenshot",
      output: [{ type: "input_image", image_url: imageUrl }],
    },
  ];
  const request = parseCodexResponsesRequest({ ...validRequest(), input });
  assert.deepEqual(request.input, input);
  for (const output of [
    [
      {
        type: "input_image",
        image_url: "data:image/png;base64," + "A".repeat(8 * 1024 * 1024),
      },
    ],
    [{ type: "input_text", text: "A".repeat(3 * 1024 * 1024) }],
    [
      {
        type: "input_image",
        image_url: "https://example.invalid/" + "A".repeat(3 * 1024 * 1024),
      },
    ],
  ]) {
    assert.throws(
      () =>
        parseCodexResponsesRequest({
          ...validRequest(),
          input: [{ ...input[0], output }],
        }),
      /oversized string/,
    );
  }
});

test("rejects unknown top-level Responses fields", () => {
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        background: true,
      }),
    /request\.background is not supported/,
  );
});

test("rejects unknown input item and tool types", () => {
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        input: [{ type: "unreviewed_provider_item", payload: "no" }],
      }),
    /input\[0\]\.type is not supported/,
  );
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        tools: [{ type: "unreviewed_provider_tool" }],
      }),
    /tools\[0\]\.type is not supported/,
  );
});

test("rejects unknown nested tool fields and unreviewed service tiers", () => {
  const request = validRequest();
  const additionalTools = request.input[0] as {
    tools: Array<{ tools: Array<Record<string, unknown>> }>;
  };

  additionalTools.tools[0]!.tools[0]!.unreviewed = true;
  assert.throws(
    () => parseCodexResponsesRequest(request),
    /input\[0\]\.tools\[0\]\.tools\[0\]\.unreviewed is not supported/,
  );
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        service_tier: "unreviewed",
      }),
    /service_tier is not supported/,
  );
  assert.doesNotThrow(() =>
    parseCodexResponsesRequest({ ...validRequest(), service_tier: "priority" }),
  );
  assert.equal(
    parseCodexResponsesRequest({ ...validRequest(), service_tier: "fast" })
      .service_tier,
    "priority",
  );
});

test("validates nested message, shell, and structured-output values", () => {
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        input: [
          {
            type: "message",
            role: "owner",
            content: [{ type: "input_text", text: "no" }],
          },
        ],
      }),
    /role is invalid/,
  );
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        input: [
          {
            type: "local_shell_call",
            call_id: "call",
            status: "completed",
            action: { type: "unreviewed", command: ["true"] },
          },
        ],
      }),
    /action is invalid/,
  );
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        text: {
          format: { type: "unreviewed", strict: true, schema: {}, name: "x" },
        },
      }),
    /text\.format is invalid/,
  );
});

test("reconstructs structured tool output and rejects unknown fields", () => {
  const parsed = parseCodexResponsesRequest({
    ...validRequest(),
    input: [
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
            encrypted_content: "opaque",
          },
        ],
      },
    ],
  });

  assert.deepEqual(parsed.input[0]?.output, [
    { type: "input_text", text: "Screenshot" },
    {
      type: "input_image",
      image_url: "data:image/png;base64,aGVsbG8=",
      detail: "original",
    },
    { type: "encrypted_content", encrypted_content: "opaque" },
  ]);
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        input: [
          {
            type: "function_call_output",
            call_id: "call-invalid",
            output: { raw: "not a Codex tool output" },
          },
        ],
      }),
    /output must be an array/,
  );
  assert.throws(
    () =>
      parseCodexResponsesRequest({
        ...validRequest(),
        input: [
          {
            type: "function_call_output",
            call_id: "call-unknown",
            output: [
              { type: "input_text", text: "Screenshot", internal: "drop" },
            ],
          },
        ],
      }),
    /internal is not supported/,
  );
});

test("requires streaming and forbids provider-side storage", () => {
  assert.throws(
    () => parseCodexResponsesRequest({ ...validRequest(), stream: false }),
    /stream must be true/,
  );
  assert.throws(
    () => parseCodexResponsesRequest({ ...validRequest(), store: true }),
    /store must be false/,
  );
});

test("maps Codex bundled model slugs to canonical gateway ids", () => {
  assert.equal(codexGatewayModelId("gpt-5.6-luna"), "openai/gpt-5.6-luna");
  assert.equal(
    codexGatewayModelId("openai/gpt-5.6-luna"),
    "openai/gpt-5.6-luna",
  );
});

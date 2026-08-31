import type {
  AnthropicMessagesRequest,
  AnthropicMessageResponse,
} from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "../wire/sse";

import {
  UnsupportedAnthropicContentError,
  anthropicToResponses,
} from "./anthropic-to-responses";
import {
  aggregateResponsesToAnthropic,
  responsesSseToAnthropicStream,
  transformResponsesResponse,
} from "./responses-to-anthropic";

test("Anthropic requests map system, images, tools, results, and reasoning to Responses", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", enum: ["src/file.ts", "README.md"] },
    },
  };
  const request: AnthropicMessagesRequest = {
    model: "public-model",
    max_tokens: 30_000,
    system: [
      { type: "text", text: "System one" },
      { type: "text", text: "System two" },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling a tool" },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { z: 2, a: 1 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [
              { type: "text", text: "contents" },
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://images.example/result.png",
                },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      { name: "read_file", description: "Read a file", input_schema: schema },
    ],
    tool_choice: { type: "any" },
    thinking: { type: "enabled", budget_tokens: 30_000 },
  };

  const converted = anthropicToResponses(request, {
    model: "gpt-5-codex",
    provider: "openai",
    sessionId: "session-1",
  });

  assert.equal(converted.instructions, "System one\n\nSystem two");
  assert.equal(converted.max_output_tokens, 30_000);
  assert.equal(converted.prompt_cache_key, "session-1");
  assert.equal(converted.tool_choice, "required");
  assert.deepEqual(converted.reasoning, { effort: "xhigh", summary: "auto" });
  assert.deepEqual(converted.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(converted.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Inspect this" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Calling a tool" }],
    },
    {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"a":1,"z":2}',
    },
    { type: "function_call_output", call_id: "call-1", output: "contents" },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://images.example/result.png" },
      ],
    },
  ]);

  const xai = anthropicToResponses(request, {
    model: "grok-4.5",
    provider: "xai",
  });
  const xaiPath = xai.tools?.[0]?.parameters.properties as Record<
    string,
    Record<string, unknown>
  >;

  assert.equal(
    "enum" in xaiPath.path,
    false,
    "slash enums are stripped only from the xAI copy",
  );
  assert.deepEqual(
    schema.properties.path.enum,
    ["src/file.ts", "README.md"],
    "source request is not mutated",
  );
});

test("explicit Claude effort takes precedence when translating to Responses", () => {
  const converted = anthropicToResponses(
    {
      model: "public-model",
      max_tokens: 1_000,
      messages: [{ role: "user", content: "Think" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    },
    { model: "gpt-5.6-sol", provider: "openai" },
  );

  assert.deepEqual(converted.reasoning, { effort: "max", summary: "auto" });
});

test("unsafe image URLs are rejected instead of being forwarded", () => {
  const request: AnthropicMessagesRequest = {
    model: "model",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "http://internal.example/image" },
          },
        ],
      },
    ],
  };

  assert.throws(
    () => anthropicToResponses(request, { model: "gpt", provider: "openai" }),
    (error) =>
      error instanceof UnsupportedAnthropicContentError &&
      /Only HTTPS/.test(error.message),
  );
});

test("Responses JSON aggregation maps reasoning, text, tools, stop reason, and cached usage", () => {
  const message = aggregateResponsesToAnthropic(
    {
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Considered options" }],
        },
        { type: "message", content: [{ type: "output_text", text: "Result" }] },
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
      },
    },
    { publicModel: "openai/gpt" },
  );

  assert.equal(message.id, "resp-1");
  assert.equal(message.model, "openai/gpt");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "Considered options", signature: "" },
    { type: "text", text: "Result" },
    {
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "a.ts" },
    },
  ]);
  assert.deepEqual(message.usage, {
    input_tokens: 15,
    output_tokens: 7,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 2,
  });
});

function responsesFixture(): string {
  const event = (type: string, value: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\r\n\r\n`;

  return [
    event("response.created", {
      response: { id: "resp-stream", status: "in_progress", usage: null },
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc-1",
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
      },
    }),
    event("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc-1",
      delta: '{"path":',
    }),
    event("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc-1",
      delta: '"src/index.ts"}',
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: { id: "fc-1", type: "function_call" },
    }),
    event("response.output_text.delta", {
      output_index: 1,
      item_id: "msg-1",
      content_index: 0,
      delta: "Done",
    }),
    event("response.content_part.done", {
      output_index: 1,
      item_id: "msg-1",
      content_index: 0,
    }),
    event("response.reasoning_summary_text.delta", {
      output_index: 2,
      item_id: "reason-1",
      delta: "Checked the file",
    }),
    event("response.completed", {
      response: {
        id: "resp-stream",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 2 },
        },
      },
    }),
  ].join("");
}

test("fragmented Responses SSE converts to ordered Anthropic protocol events", async () => {
  const fixture = responsesFixture();
  const upstream = streamFromStrings([
    fixture.slice(0, 13),
    fixture.slice(13, 157),
    fixture.slice(157, 511),
    fixture.slice(511),
  ]);
  const translated = responsesSseToAnthropicStream(upstream, {
    publicModel: "xai/grok-4.5",
  });
  const events: Array<{ event?: string; data: Record<string, unknown> }> = [];

  for await (const frame of parseSseStream(translated)) {
    events.push({
      event: frame.event,
      data: JSON.parse(frame.data) as Record<string, unknown>,
    });
  }

  assert.equal(events[0]?.event, "message_start");
  const starts = events.filter(
    (entry) => entry.event === "content_block_start",
  );

  assert.deepEqual(
    starts.map(
      (entry) => (entry.data.content_block as Record<string, unknown>).type,
    ),
    ["tool_use", "text", "thinking"],
  );
  const deltas = events
    .filter((entry) => entry.event === "content_block_delta")
    .map((entry) => entry.data.delta as Record<string, unknown>);

  assert.equal(
    deltas
      .filter((delta) => delta.type === "input_json_delta")
      .map((delta) => delta.partial_json)
      .join(""),
    '{"path":"src/index.ts"}',
  );
  assert.equal(
    deltas.find((delta) => delta.type === "text_delta")?.text,
    "Done",
  );
  assert.equal(
    deltas.find((delta) => delta.type === "thinking_delta")?.thinking,
    "Checked the file",
  );
  const messageDelta = events.find(
    (entry) => entry.event === "message_delta",
  )?.data;

  assert.equal(
    (messageDelta?.delta as Record<string, unknown>).stop_reason,
    "tool_use",
  );
  assert.deepEqual(messageDelta?.usage, {
    input_tokens: 8,
    output_tokens: 4,
    cache_read_input_tokens: 2,
  });
  assert.equal(events.at(-1)?.event, "message_stop");
});

test("clean Responses terminal without usage retains conservative billing", async () => {
  const fixture = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: "missing-usage", status: "in_progress" },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "missing-usage", status: "completed" },
    })}\n\n`,
  ].join("");
  const translated = responsesSseToAnthropicStream(
    streamFromStrings([fixture]),
    {
      publicModel: "xai/grok",
      conservativeBilledInputTokens: 900,
      conservativeBilledOutputTokens: 1_200,
    },
  );
  let terminalUsage: unknown;

  for await (const frame of parseSseStream(translated)) {
    if (frame.event === "message_delta") {
      terminalUsage = (JSON.parse(frame.data) as Record<string, unknown>).usage;
    }
  }
  assert.deepEqual(terminalUsage, {
    input_tokens: 900,
    output_tokens: 1_200,
  });
});

test("partial Responses usage cannot clear an omitted output projection", async () => {
  const message = aggregateResponsesToAnthropic(
    {
      id: "partial-usage",
      status: "completed",
      output: [],
      usage: { input_tokens: 10 },
    },
    {
      publicModel: "openai/gpt",
      conservativeBilledInputTokens: 900,
      conservativeBilledOutputTokens: 1_200,
    },
  );

  assert.deepEqual(message.usage, {
    input_tokens: 10,
    output_tokens: 1_200,
  });
});

test("non-stream callers aggregate Responses SSE when the provider omits content-type", async () => {
  const response = await transformResponsesResponse(
    new Response(responsesFixture()),
    {
      publicModel: "openai/gpt",
      requestStream: false,
      upstreamIsSse: true,
    },
  );
  const message = (await response.json()) as AnthropicMessageResponse;

  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(message.id, "resp-stream");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content, [
    {
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "src/index.ts" },
    },
    { type: "text", text: "Done" },
    { type: "thinking", thinking: "Checked the file", signature: "" },
  ]);
  assert.deepEqual(message.usage, {
    input_tokens: 8,
    output_tokens: 4,
    cache_read_input_tokens: 2,
  });
});

test("Responses translation honors backpressure and propagates downstream cancellation", async () => {
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
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              output_index: pulls,
              item_id: `message-${pulls}`,
              content_index: 0,
              delta: "x",
            })}\n\n`,
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
  const translated = responsesSseToAnthropicStream(upstream, {
    publicModel: "openai/gpt",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pulls <= 1, `transform prefetched ${pulls} upstream chunks`);
  const reader = translated.getReader();
  const first = await reader.read();

  assert.equal(first.done, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    pulls,
    1,
    "queued output from one event should apply backpressure",
  );
  await reader.cancel("Responses client disconnected");
  await Promise.race([
    cancelled,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("upstream cancellation timed out")),
        250,
      ),
    ),
  ]);
  assert.equal(cancelReason, "Responses client disconnected");
});

test("Responses translation conservatively enforces a local output budget", async () => {
  const event = `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "message-1",
    content_index: 0,
    delta: "abcdefgh",
  })}\n\n`;
  const translated = responsesSseToAnthropicStream(streamFromStrings([event]), {
    publicModel: "openai/gpt",
    conservativeOutputByteLimit: 5,
    conservativeBilledInputTokens: 9_999,
    conservativeBilledOutputTokens: 128_000,
  });
  const events: Array<{ event?: string; data: Record<string, unknown> }> = [];

  for await (const frame of parseSseStream(translated)) {
    events.push({
      event: frame.event,
      data: JSON.parse(frame.data) as Record<string, unknown>,
    });
  }
  const text = events
    .filter(({ event: name }) => name === "content_block_delta")
    .map(({ data }) => (data.delta as Record<string, unknown>).text)
    .join("");
  const messageDelta = events.find(
    ({ event: name }) => name === "message_delta",
  );

  assert.equal(text, "abcde");
  assert.equal(
    (messageDelta?.data.delta as Record<string, unknown>).stop_reason,
    "max_tokens",
  );
  assert.equal(
    (messageDelta?.data.usage as Record<string, unknown>).output_tokens,
    128_000,
  );
  assert.equal(
    (messageDelta?.data.usage as Record<string, unknown>).input_tokens,
    9_999,
  );
  assert.equal(events.at(-1)?.event, "message_stop");
});

test("a truncated Responses stream emits an error without a synthetic message_stop", async () => {
  const partial = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: "truncated", status: "in_progress" },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "message-1",
      content_index: 0,
      delta: "partial",
    })}\n\n`,
  ];
  const translated = responsesSseToAnthropicStream(streamFromStrings(partial), {
    publicModel: "openai/gpt",
  });
  const names: string[] = [];

  for await (const frame of parseSseStream(translated)) {
    if (frame.event) names.push(frame.event);
  }

  assert.equal(names.includes("message_stop"), false);
  assert.equal(names.at(-1), "error");
});

test("Responses stream errors expose only the fixed public error payload", async () => {
  const secret = "Bearer upstream-secret-token";
  const created = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: { id: "failed-response", status: "in_progress" },
  })}\n\n`;
  const failures = [
    `event: response.failed\ndata: raw failure ${secret}\n\n`,
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { message: `provider rejected ${secret}` },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.failed",
      response: {
        error: {
          message: `provider rejected ${secret}`,
          internal_request_id: "provider-request-secret",
        },
      },
    })}\n\n`,
  ];

  for (const failure of failures) {
    const translated = responsesSseToAnthropicStream(
      streamFromStrings([created, failure]),
      { publicModel: "openai/gpt" },
    );
    const frames: Array<{
      event?: string;
      data: Record<string, unknown>;
    }> = [];

    for await (const frame of parseSseStream(translated)) {
      frames.push({
        event: frame.event,
        data: JSON.parse(frame.data) as Record<string, unknown>,
      });
    }
    const error = frames.at(-1);

    assert.deepEqual(error, {
      event: "error",
      data: {
        type: "error",
        error: {
          type: "api_error",
          message: "Upstream provider request failed",
        },
      },
    });
    assert.doesNotMatch(
      JSON.stringify(error),
      /upstream-secret|provider-request/,
    );
    assert.equal(
      frames.some((frame) => frame.event === "message_stop"),
      false,
    );
  }
});

test("non-stream Responses aggregation does not expose provider error text", async () => {
  const secret = "sk-provider-secret";
  const failure = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: "failed-response", status: "in_progress" },
    })}\n\n`,
    `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: { error: { message: `provider rejected ${secret}` } },
    })}\n\n`,
  ].join("");

  await assert.rejects(
    transformResponsesResponse(
      new Response(failure, {
        headers: { "content-type": "text/event-stream" },
      }),
      { publicModel: "openai/gpt", requestStream: false },
    ),
    (error) =>
      error instanceof Error &&
      error.message === "Upstream provider request failed" &&
      !error.message.includes(secret),
  );
});

test("non-stream aggregation rejects a truncated Responses stream", async () => {
  const partial = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: { id: "truncated", status: "in_progress" },
  })}\n\n`;

  await assert.rejects(
    transformResponsesResponse(
      new Response(partial, {
        headers: { "content-type": "text/event-stream" },
      }),
      { publicModel: "openai/gpt", requestStream: false },
    ),
    /Upstream provider request failed/,
  );
});

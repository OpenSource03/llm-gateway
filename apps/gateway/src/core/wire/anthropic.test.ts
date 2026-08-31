import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ANTHROPIC_OUTPUT_TOKENS,
  assertAnthropicMessagesRequest,
} from "./anthropic";

const valid = () => ({
  model: "anthropic/test",
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello" }],
});

test("Messages validation accepts the supported nested contract", () => {
  assert.doesNotThrow(() =>
    assertAnthropicMessagesRequest({
      ...valid(),
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read",
              input: {},
              caller: { type: "direct" },
              cache_control: { type: "ephemeral", ttl: "1h" },
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
                { type: "text", text: "ok" },
                { type: "tool_reference", tool_name: "read" },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "read",
          input_schema: { type: "object" },
          defer_loading: true,
        },
      ],
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      output_config: { effort: "xhigh" },
      thinking: { type: "adaptive", display: "omitted" },
    }),
  );
});

test("Messages validation rejects malformed nested input before routing", () => {
  for (const request of [
    { ...valid(), messages: [null] },
    { ...valid(), messages: [{ role: "user", content: [null] }] },
    {
      ...valid(),
      messages: [{ role: "user", content: [{ type: "tool_use" }] }],
    },
    { ...valid(), tools: [{ name: "broken" }] },
    {
      ...valid(),
      tools: [
        {
          name: "read",
          input_schema: { type: "object" },
          defer_loading: "yes",
        },
      ],
    },
    {
      ...valid(),
      messages: [
        {
          role: "user",
          content: [{ type: "tool_reference", tool_name: "read" }],
        },
      ],
    },
    {
      ...valid(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "text/html",
                data: "PGh0bWw+",
              },
            },
          ],
        },
      ],
    },
    {
      ...valid(),
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call",
              name: "read",
              input: {},
              caller: { type: "unreviewed" },
            },
          ],
        },
      ],
    },
    {
      ...valid(),
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
    },
    {
      ...valid(),
      tools: [
        { name: "read", input_schema: {} },
        { name: "Read", input_schema: {} },
      ],
    },
    { ...valid(), temperature: Number.NaN },
    { ...valid(), stream: "true" },
    { ...valid(), context_management: [] },
    { ...valid(), context_management: { edits: [] } },
    {
      ...valid(),
      context_management: {
        edits: [{ type: "clear_tool_uses_20250919" }],
      },
    },
    {
      ...valid(),
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: -1 },
          },
        ],
      },
    },
    { ...valid(), output_config: { effort: "unbounded" } },
    { ...valid(), output_config: { provider_extension: true } },
    { ...valid(), thinking: { type: "adaptive", display: "unreviewed" } },
    { ...valid(), unreviewed_provider_feature: { resource_id: "shared" } },
    {
      ...valid(),
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call",
              name: "read",
              input: { nested: { too: { deep: {} } } },
              provider_extension: true,
            },
          ],
        },
      ],
    },
    { ...valid(), max_tokens: MAX_ANTHROPIC_OUTPUT_TOKENS + 1 },
  ]) {
    assert.throws(() => assertAnthropicMessagesRequest(request), TypeError);
  }
});

test("Messages validation bounds recursive tool/schema JSON", () => {
  let nested: Record<string, unknown> = {};

  for (let index = 0; index < 42; index += 1) nested = { next: nested };
  assert.throws(
    () =>
      assertAnthropicMessagesRequest({
        ...valid(),
        tools: [{ name: "deep", input_schema: nested }],
      }),
    /nested too deeply/,
  );
});

test("token-count validation may omit max_tokens but cannot smuggle it", () => {
  const countRequest: Record<string, unknown> = { ...valid() };

  delete countRequest.max_tokens;

  assert.doesNotThrow(() =>
    assertAnthropicMessagesRequest(countRequest, {
      allowMissingMaxTokens: true,
    }),
  );
  assert.throws(
    () =>
      assertAnthropicMessagesRequest(
        { ...countRequest, max_tokens: "unbounded" },
        { allowMissingMaxTokens: true },
      ),
    TypeError,
  );
});

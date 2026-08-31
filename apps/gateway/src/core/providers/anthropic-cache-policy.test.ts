import type { AnthropicMessagesRequest } from "../wire/anthropic";

import assert from "node:assert/strict";
import test from "node:test";

import { promoteAnthropicSubscriptionCacheRetention } from "./anthropic-cache-policy";

interface Cacheable {
  cache_control?: unknown;
}

test("promotes existing Anthropic breakpoints without creating new ones", () => {
  const request: AnthropicMessagesRequest = {
    model: "claude-sonnet-5",
    max_tokens: 1_000,
    system: [
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "uncached" },
    ],
    tools: [
      {
        name: "read",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      },
    ],
  };

  promoteAnthropicSubscriptionCacheRetention(request);

  assert.deepEqual((request.system as Array<Cacheable>)[0]?.cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
  assert.equal(
    (request.system as Array<Cacheable>)[1]?.cache_control,
    undefined,
  );
  assert.deepEqual(request.tools?.[0]?.cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
  const toolResult = (
    request.messages[0]?.content as Array<{
      content: Array<Cacheable>;
    }>
  )[0];

  assert.deepEqual(toolResult?.content[0]?.cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
});

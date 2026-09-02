import type { AnthropicMessagesRequest } from "./wire/anthropic";
import type { CodexResponsesRequest } from "./wire/codex-responses";

import assert from "node:assert/strict";
import test from "node:test";

import {
  currentRoutingQuotaSnapshots,
  estimateGatewayInputTokens,
  estimateGatewayResponsesInputTokens,
  parseGatewayQuotaRules,
} from "./data-plane.service";

test("input cap reservation is conservative for adversarial byte-heavy text", () => {
  const request: AnthropicMessagesRequest = {
    model: "anthropic/test",
    max_tokens: 100,
    messages: [{ role: "user" as const, content: "\u0000".repeat(2_000) }],
  };
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    }),
    "utf8",
  );
  const estimate = estimateGatewayInputTokens(request);

  assert.ok(estimate.conservative > serializedBytes);
  assert.ok(estimate.conservative >= estimate.approximate);
});

test("Responses image estimates use image dimensions instead of base64 transport bytes", () => {
  const png = Buffer.alloc(486_035);

  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(1_215, 16);
  png.writeUInt32BE(810, 20);
  const request: CodexResponsesRequest = {
    model: "gpt-5.6-sol",
    instructions: "Inspect the screenshot",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${png.toString("base64")}`,
            detail: "auto",
          },
        ],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
  const estimate = estimateGatewayResponsesInputTokens(request);

  assert.ok(estimate.approximate >= 1_186);
  assert.ok(estimate.approximate < 2_000);
  assert.ok(estimate.conservative < 3_000);
  assert.ok(estimate.conservative >= estimate.approximate);
});

test("routing quota controls convert UI basis points to engine ratios", () => {
  assert.deepEqual(
    parseGatewayQuotaRules({ maxUtilizationBps: 9_500, reserveBps: 500 }),
    { maxUsedRatio: 0.95, reserveRatio: 0.05 },
  );
  assert.deepEqual(
    parseGatewayQuotaRules({ maxUsedRatio: 0.9, reserveRatio: 0.1 }),
    { maxUsedRatio: 0.9, reserveRatio: 0.1 },
  );
});

test("a complete poll supersedes older response-header quota windows", () => {
  const old = new Date("2026-08-12T22:34:04.385Z");
  const current = new Date("2026-08-27T11:11:46.351Z");
  const newer = new Date("2026-08-27T11:12:00.000Z");
  const selected = currentRoutingQuotaSnapshots([
    {
      source: "RESPONSE_HEADER",
      meterKey: "chat",
      windowKey: "secondary",
      observedAt: old,
    },
    {
      source: "POLL",
      meterKey: "chat",
      windowKey: "primary",
      observedAt: current,
    },
    {
      source: "RESPONSE_HEADER",
      meterKey: "chat",
      windowKey: "primary",
      observedAt: newer,
    },
  ]);

  assert.deepEqual(
    selected.map(({ source, windowKey }) => [source, windowKey]),
    [["RESPONSE_HEADER", "primary"]],
  );
});

test("Responses estimates remain advisory above a provider context limit", () => {
  const request: CodexResponsesRequest = {
    model: "anthropic/test",
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(40_000) }],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };

  // A heuristic estimate can exceed a discovered provider limit even when the
  // provider's tokenizer would accept the request. Enforcement therefore stays
  // with the upstream provider; this value is only used for accounting.
  assert.ok(estimateGatewayResponsesInputTokens(request).approximate > 10_000);
});

import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeModelInfo } from "./claude-model-info";

test("builds full Claude ModelInfo for an authoritative 1M model", () => {
  const info = claudeCodeModelInfo({
    capabilities: {
      inputModalities: ["text", "image"],
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      thinkingModes: ["adaptive", "enabled"],
      contextManagement: { clearThinking: true, compact: true },
    },
    contextWindow: 1_000_000,
    displayName: "Claude Sonnet 5",
    lastSeenAt: "2026-08-27T12:00:00.000Z",
    maxOutputTokens: 128_000,
    provider: "ANTHROPIC",
    publicModelId: "anthropic/claude-sonnet-5",
    upstreamModelId: "claude-sonnet-5",
  });

  assert.equal(info.id, "claude-sonnet-5[1m]");
  assert.equal(info.display_name, "Claude Sonnet 5 · 1M");
  assert.equal(info.max_input_tokens, 1_000_000);
  assert.equal(info.max_tokens, 128_000);
  assert.equal(info.capabilities.image_input.supported, true);
  assert.equal(info.capabilities.effort.xhigh?.supported, true);
  assert.equal(info.capabilities.effort.max.supported, false);
  assert.equal(info.capabilities.thinking.types.adaptive.supported, true);
  assert.equal(info.capabilities.context_management.supported, true);
  assert.equal(
    info.capabilities.context_management.compact_20260112?.supported,
    true,
  );
});

test("keeps non-reasoning routed aliases honest", () => {
  const info = claudeCodeModelInfo({
    capabilities: { inputModalities: ["text"], reasoning: false },
    contextWindow: 300_000,
    displayName: "External model",
    lastSeenAt: "invalid",
    maxOutputTokens: null,
    provider: "OPENAI",
    publicModelId: "openai/external-model",
    upstreamModelId: "external-model",
  });

  assert.match(info.id, /^claude-llmgw-/);
  assert.equal(info.created_at, "1970-01-01T00:00:00.000Z");
  assert.equal(info.capabilities.effort.supported, false);
  assert.equal(info.capabilities.image_input.supported, false);
});

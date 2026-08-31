import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalGatewayModelIdFromClaudeCode,
  claudeCodeModelId,
} from "./claude-model-id";

test("publishes canonical Anthropic ids with authoritative 1M markers", () => {
  const id = claudeCodeModelId({
    contextWindow: 1_000_000,
    provider: "ANTHROPIC",
    publicModelId: "anthropic/claude-sonnet-5",
    upstreamModelId: "claude-sonnet-5",
  });

  assert.equal(id, "claude-sonnet-5[1m]");
  assert.equal(
    canonicalGatewayModelIdFromClaudeCode(id),
    "anthropic/claude-sonnet-5",
  );
});

test("does not overstate smaller Claude context windows", () => {
  assert.equal(
    claudeCodeModelId({
      contextWindow: 200_000,
      provider: "ANTHROPIC",
      publicModelId: "anthropic/claude-haiku-4-5-20251001",
      upstreamModelId: "claude-haiku-4-5-20251001",
    }),
    "claude-haiku-4-5-20251001",
  );
});

test("round-trips readable routed aliases and rejects malformed encodings", () => {
  const id = claudeCodeModelId({
    contextWindow: 2_000_000,
    provider: "XAI",
    publicModelId: "xai/grok-4.20/reasoning",
    upstreamModelId: "grok-4.20/reasoning",
  });

  assert.equal(id, "claude-llmgw-xai--grok-4.20~sreasoning[1m]");
  assert.equal(
    canonicalGatewayModelIdFromClaudeCode(id),
    "xai/grok-4.20/reasoning",
  );
  assert.equal(
    canonicalGatewayModelIdFromClaudeCode("claude-arcademy-xai--bad~escape"),
    null,
  );
});

test("accepts legacy Arcademy aliases during standalone migration", () => {
  assert.equal(
    canonicalGatewayModelIdFromClaudeCode(
      "claude-arcademy-xai--grok-4.20~sreasoning",
    ),
    "xai/grok-4.20/reasoning",
  );
});

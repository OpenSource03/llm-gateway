import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSyntheticCodexModel,
  hasRequiredNativeCodexMetadata,
  publishNativeCodexModel,
} from "./codex-model";

const model = {
  capabilities: {
    inputModalities: ["text", "image"],
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  contextWindow: 1_000_000,
  description: "Provider model",
  displayName: "Claude Sonnet 5",
  provider: "ANTHROPIC" as const,
  publicModelId: "anthropic/claude-sonnet-5",
  upstreamModelId: "claude-sonnet-5",
};

test("builds a compact code-mode catalog row from adapter capabilities", () => {
  const row = buildSyntheticCodexModel(model, 1_000, {
    modelIdSource: "public",
    supportsSearchTool: true,
    toolMode: "code_mode_only",
    webSearchToolType: null,
  });

  assert.equal(row.slug, "anthropic/claude-sonnet-5");
  assert.equal(row.tool_mode, "code_mode_only");
  assert.equal(row.supports_search_tool, true);
  assert.deepEqual(
    (row.supported_reasoning_levels as Array<{ effort: string }>).map(
      ({ effort }) => effort,
    ),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(Object.hasOwn(row, "web_search_tool_type"), false);
  assert.equal(row.base_instructions, "");
  assert.deepEqual(row.input_modalities, ["text", "image"]);
  assert.equal(row.multi_agent_version, "v2");
});

test("enables the Codex V2 harness without provider-specific branching", () => {
  for (const provider of ["ANTHROPIC", "XAI", "FUTURE_PROVIDER"]) {
    const row = buildSyntheticCodexModel(
      { ...model, provider, publicModelId: `${provider.toLowerCase()}/model` },
      1_000,
      {
        modelIdSource: "public",
        supportsSearchTool: true,
        toolMode: "direct",
        webSearchToolType: null,
      },
    );

    assert.equal(row.multi_agent_version, "v2");
  }
});

test("uses a discovered provider default when medium is unavailable", () => {
  const row = buildSyntheticCodexModel(
    {
      ...model,
      capabilities: {
        inputModalities: ["text"],
        reasoning: true,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    },
    1_000,
    {
      modelIdSource: "public",
      supportsSearchTool: false,
      toolMode: "direct",
      webSearchToolType: null,
    },
  );

  assert.equal(row.default_reasoning_level, "high");
});

test("does not invent an effort knob for thinking-only models", () => {
  const row = buildSyntheticCodexModel(
    {
      ...model,
      capabilities: {
        inputModalities: ["text", "image"],
        reasoning: true,
        reasoningEfforts: [],
      },
    },
    1_000,
    {
      modelIdSource: "public",
      supportsSearchTool: true,
      toolMode: "code_mode_only",
      webSearchToolType: null,
    },
  );

  assert.equal(row.default_reasoning_level, "none");
  assert.deepEqual(row.supported_reasoning_levels, []);
});

test("keeps native OpenAI slugs and direct tool mode when requested", () => {
  const row = buildSyntheticCodexModel(
    {
      ...model,
      provider: "OPENAI",
      publicModelId: "openai/gpt-5.6-luna",
      upstreamModelId: "gpt-5.6-luna",
    },
    10,
    {
      modelIdSource: "upstream",
      supportsSearchTool: false,
      toolMode: "direct",
      webSearchToolType: null,
    },
  );

  assert.equal(row.slug, "gpt-5.6-luna");
  assert.equal(row.tool_mode, "direct");
});

test("keeps each provider-native model's own instruction metadata", () => {
  const first = publishNativeCodexModel(
    {
      slug: "model-a",
      display_name: "Model A",
      base_instructions: "Instructions for A",
    },
    "model-a",
  );
  const second = publishNativeCodexModel(
    { slug: "model-b", display_name: "Model B" },
    "model-b",
  );

  assert.equal(first.base_instructions, "Instructions for A");
  assert.equal(second.base_instructions, undefined);
  assert.equal(first.visibility, "list");
  assert.equal(second.visibility, "list");
});

test("rejects abbreviated native metadata that strict Codex clients cannot parse", () => {
  assert.equal(
    hasRequiredNativeCodexMetadata({
      slug: "hidden-fragment",
      display_name: "Hidden fragment",
    }),
    false,
  );
  assert.equal(
    hasRequiredNativeCodexMetadata({
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
      supported_in_api: true,
      priority: 1,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [],
    }),
    true,
  );
});

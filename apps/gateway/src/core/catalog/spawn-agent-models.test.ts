import type { CodexResponsesRequest } from "../wire/codex-responses";

import assert from "node:assert/strict";
import test from "node:test";

import { injectSpawnAgentModelCatalog } from "./spawn-agent-models";

const request = (): CodexResponsesRequest => ({
  model: "gpt-5.6-luna",
  instructions: "",
  input: [{ type: "message", role: "user", content: [] }],
  tools: [],
  tool_choice: "auto",
  parallel_tool_calls: false,
  store: false,
  stream: true,
  include: [],
});

const models = [
  {
    slug: "gpt-5.6-luna",
    visibility: "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
    ],
  },
  {
    slug: "anthropic/claude-opus-5",
    visibility: "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "max" },
    ],
  },
  {
    slug: "xai/grok-future",
    visibility: "list",
    default_reasoning_level: "none",
    supported_reasoning_levels: [],
  },
  { slug: "hidden-model", visibility: "hide" },
];

test("injects every visible live model into a V1 namespace tool", () => {
  const source = request();

  source.tools = [
    {
      type: "namespace",
      name: "multi_agent_v1",
      description: "Collaboration tools",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          description: "Available model overrides: five-item preview",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  ];

  const injected = injectSpawnAgentModelCatalog(source, models);
  const namespace = injected.tools?.[0] as Record<string, unknown>;
  const spawn = (namespace.tools as Array<Record<string, unknown>>)[0]!;
  const description = String(spawn.description);

  assert.notEqual(injected, source);
  assert.match(description, /"gpt-5\.6-luna"/);
  assert.match(description, /"anthropic\/claude-opus-5"/);
  assert.match(description, /"xai\/grok-future"/);
  assert.match(description, /"reasoning_efforts":\["low","medium","high"\]/);
  assert.match(description, /"default_reasoning_effort":"medium"/);
  assert.match(description, /"reasoning_efforts":\[\]/);
  assert.doesNotMatch(description, /hidden-model/);
  assert.equal(
    String(
      (
        (source.tools[0] as Record<string, unknown>).tools as Array<
          Record<string, unknown>
        >
      )[0]?.description,
    ),
    "Available model overrides: five-item preview",
  );
});

test("injects deferred and V2 spawn tools without changing unrelated tools", () => {
  const source = request();
  const unrelated = {
    type: "function",
    name: "other_tool",
    description: "Unchanged",
    parameters: { type: "object", properties: {} },
  };

  source.input.push({
    type: "additional_tools",
    tools: [
      unrelated,
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn an agent",
        parameters: { type: "object", properties: {} },
      },
    ],
  });

  const injected = injectSpawnAgentModelCatalog(source, models);
  const additional = injected.input[1]?.tools as Array<Record<string, unknown>>;

  assert.equal(additional[0], unrelated);
  assert.match(String(additional[1]?.description), /anthropic\/claude-opus-5/);
});

test("injects the catalog into a deferred V1 code-mode search result", () => {
  const source = request();

  source.input.push({
    type: "custom_tool_call_output",
    call_id: "search-call",
    name: "exec",
    output: [
      {
        type: "input_text",
        text: "Available model overrides:\n- gpt-5.6-luna",
      },
    ],
  });

  const injected = injectSpawnAgentModelCatalog(source, models);
  const output = injected.input[1]?.output as Array<Record<string, unknown>>;
  const description = String(output[0]?.text);

  assert.match(description, /"anthropic\/claude-opus-5"/);
  assert.match(description, /"xai\/grok-future"/);
  assert.doesNotMatch(
    String(
      (source.input[1]?.output as Array<Record<string, unknown>>)[0]?.text,
    ),
    /llm_gateway_spawn_model_catalog/,
  );
});

test("leaves requests without spawn-agent tools unchanged", () => {
  const source = request();

  source.tools = [
    {
      type: "function",
      name: "other_tool",
      description: "Unchanged",
      parameters: { type: "object", properties: {} },
    },
  ];

  assert.equal(injectSpawnAgentModelCatalog(source, models), source);
});

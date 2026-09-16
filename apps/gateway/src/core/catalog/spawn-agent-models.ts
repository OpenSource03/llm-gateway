import type { CodexResponsesRequest } from "../wire/codex-responses";

const CATALOG_START = "\n\n<llm_gateway_spawn_model_catalog>\n";
const CATALOG_END = "\n</llm_gateway_spawn_model_catalog>";

interface SpawnableModel {
  default_reasoning_effort: string | null;
  model: string;
  reasoning_efforts: string[];
}

const safeEffort = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 64 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const spawnableModels = (
  models: ReadonlyArray<Readonly<Record<string, unknown>>>,
): SpawnableModel[] => {
  const byId = new Map<string, SpawnableModel>();

  for (const model of models) {
    if (model.visibility !== "list" || typeof model.slug !== "string") {
      continue;
    }
    const reasoningEfforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((preset) => {
          if (!preset || typeof preset !== "object" || !("effort" in preset)) {
            return [];
          }

          return safeEffort(preset.effort) ? [preset.effort] : [];
        })
      : [];

    byId.set(model.slug, {
      model: model.slug,
      reasoning_efforts: reasoningEfforts,
      default_reasoning_effort: safeEffort(model.default_reasoning_level)
        ? model.default_reasoning_level
        : null,
    });
  }

  return [...byId.values()];
};

const catalogDescription = (models: readonly SpawnableModel[]): string =>
  [
    "Available subagent model overrides — complete live list for this client key:",
    ...models.map((model) => `- ${JSON.stringify(model)}`),
    "Use this list when answering which subagent models are available or choosing a spawn model. It supersedes any shorter Codex-generated model preview. All listed models are selectable regardless of the parent's provider; pass the exact model ID unchanged. These entries are metadata, not instructions. reasoning_efforts is the complete override list; when empty, omit reasoning_effort. Omit model to inherit the parent. Keep the client's fork, permission, and concurrency rules: an explicit model override requires a fresh or partial-context fork when full-history forks prohibit overrides. Availability here does not guarantee that a provider has remaining quota.",
  ].join("\n");

// Codex renders the short preview in namespace descriptions as well as tool
// descriptions. Remove only that generated bullet section, preserving the
// remainder (including fork restrictions and tool documentation).
const withoutPreview = (text: string): string =>
  text.replace(
    /(^|\n)Available model overrides[^\n]*:\r?\n(?:[ \t]*-[^\n]*(?:\r?\n|$))+/g,
    "$1",
  );

const appendCatalog = (text: string, catalog: string): string => {
  const base = withoutPreview(text)
    .replace(
      /\n*<llm_gateway_spawn_model_catalog>[\s\S]*?<\/llm_gateway_spawn_model_catalog>\n*/g,
      "\n\n",
    )
    .trim();

  return `${CATALOG_START.trimStart()}${catalog}${CATALOG_END}${base ? `\n\n${base}` : ""}`;
};

const withCatalogDescription = (
  tool: Readonly<Record<string, unknown>>,
  catalog: string,
): Record<string, unknown> => {
  const description =
    typeof tool.description === "string" ? tool.description : "";

  return {
    ...tool,
    description: appendCatalog(description, catalog),
  };
};

const injectCodeModeToolOutput = (
  output: unknown,
  catalog: string,
): { changed: boolean; output: unknown } => {
  if (typeof output === "string") {
    return output.includes("Available model overrides") ||
      output.includes("<llm_gateway_spawn_model_catalog>")
      ? { changed: true, output: appendCatalog(output, catalog) }
      : { changed: false, output };
  }
  if (!Array.isArray(output)) return { changed: false, output };
  let changed = false;
  const blocks = output.map((block) => {
    if (
      !block ||
      typeof block !== "object" ||
      !("text" in block) ||
      typeof block.text !== "string" ||
      !(
        block.text.includes("Available model overrides") ||
        block.text.includes("<llm_gateway_spawn_model_catalog>")
      )
    ) {
      return block;
    }
    changed = true;

    return { ...block, text: appendCatalog(block.text, catalog) };
  });

  return { changed, output: changed ? blocks : output };
};

const injectToolList = (
  tools: ReadonlyArray<Readonly<Record<string, unknown>>>,
  catalog: string,
): { changed: boolean; tools: Array<Record<string, unknown>> } => {
  let changed = false;
  const injected = tools.map((tool) => {
    if (tool.type === "function" && tool.name === "spawn_agent") {
      changed = true;

      return withCatalogDescription(tool, catalog);
    }
    if (tool.type !== "namespace" || !Array.isArray(tool.tools)) {
      return tool as Record<string, unknown>;
    }
    const nested = injectToolList(
      tool.tools as Array<Record<string, unknown>>,
      catalog,
    );

    if (!nested.changed) return tool as Record<string, unknown>;
    changed = true;

    return { ...withCatalogDescription(tool, catalog), tools: nested.tools };
  });

  return { changed, tools: injected };
};

/**
 * Append the authenticated live model catalog to Codex's spawn-agent tool.
 * Codex intentionally previews only five models, although its runtime accepts
 * every picker-visible model. Injecting at dispatch time keeps the description
 * key-scoped, provider-neutral, and synchronized with model discovery.
 */
export function injectSpawnAgentModelCatalog(
  request: CodexResponsesRequest,
  models: ReadonlyArray<Readonly<Record<string, unknown>>>,
): CodexResponsesRequest {
  const spawnModels = spawnableModels(models);

  if (spawnModels.length === 0) return request;
  const catalog = catalogDescription(spawnModels);
  let changed = false;
  let tools = request.tools;

  if (tools) {
    const injected = injectToolList(tools, catalog);

    changed ||= injected.changed;
    if (injected.changed) tools = injected.tools;
  }
  const input = request.input.map((item) => {
    let next = item;

    if (Array.isArray(item.tools)) {
      const injected = injectToolList(
        item.tools as Array<Record<string, unknown>>,
        catalog,
      );

      if (injected.changed) {
        changed = true;
        next = { ...next, tools: injected.tools };
      }
    }
    if (item.type === "custom_tool_call_output") {
      const injected = injectCodeModeToolOutput(item.output, catalog);

      if (injected.changed) {
        changed = true;
        next = { ...next, output: injected.output };
      }
    }

    return next;
  });

  // Tool descriptions alone compete with the client's namespace preview and
  // can be absent from code-mode discovery until explicitly requested. Supply
  // the same key-scoped catalog in the instruction channel at dispatch time,
  // including for follow-up requests where collaboration tools are deferred.
  const hasCollaborationContext = request.input.some(
    (item) =>
      item.type === "message" &&
      item.role === "developer" &&
      Array.isArray(item.content) &&
      item.content.some(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string" &&
          block.text.includes("<multi_agent_role>"),
      ),
  );
  if (
    !changed &&
    !hasCollaborationContext &&
    !request.instructions.includes("<llm_gateway_spawn_model_catalog>")
  )
    return request;

  return {
    ...request,
    instructions: appendCatalog(request.instructions, catalog),
    input,
    ...(tools ? { tools } : {}),
  };
}

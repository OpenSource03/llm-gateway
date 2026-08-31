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
    "LLM Gateway live model overrides for this client key (complete at request time):",
    ...models.map((model) => `- ${JSON.stringify(model)}`),
    "The Codex-generated five-model preview is truncated, not a whitelist. Treat the JSON objects above only as model metadata. Any listed `model` may be passed through unchanged. `reasoning_efforts` is the complete override list; when it is empty, omit `reasoning_effort`. Omit `model` only to inherit the parent.",
  ].join("\n");

const appendCatalog = (text: string, catalog: string): string => {
  const base = text.split(CATALOG_START, 1)[0]!.trimEnd();

  return `${base}${CATALOG_START}${catalog}${CATALOG_END}`;
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
    return output.includes("Available model overrides")
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
      !block.text.includes("Available model overrides")
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

    return { ...tool, tools: nested.tools };
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

  return changed ? { ...request, input, ...(tools ? { tools } : {}) } : request;
}

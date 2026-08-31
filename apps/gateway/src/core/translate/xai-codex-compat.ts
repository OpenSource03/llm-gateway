import type { CodexResponsesRequest } from "../wire/codex-responses";

import { encodeSseFrame, parseSseStream } from "../wire/sse";

import { normalizeObjectRootToolInputSchema } from "./object-root-tool-schema";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toolKey = (name: unknown, namespace: unknown): string | null =>
  typeof name === "string" && name
    ? `${typeof namespace === "string" ? namespace : ""}\u0000${name}`
    : null;

const customToolParameters = (name: string): Record<string, unknown> => ({
  type: "object",
  properties: {
    input: {
      type: "string",
      description:
        name === "apply_patch"
          ? "Raw patch input beginning with *** Begin Patch."
          : "Raw freeform input for this tool.",
    },
  },
  required: ["input"],
  additionalProperties: false,
});

interface ToolRegistry {
  custom: Set<string>;
  functions: Set<string>;
}

const rememberToolKind = (
  registry: ToolRegistry,
  key: string | null,
  kind: "custom" | "function",
): void => {
  if (!key) return;
  const other = kind === "custom" ? registry.functions : registry.custom;

  if (other.has(key)) {
    throw new TypeError(
      "xAI cannot disambiguate function and custom tools with the same name",
    );
  }
  registry[kind === "custom" ? "custom" : "functions"].add(key);
};

const lowerToolDefinitions = (
  tools: Array<Record<string, unknown>>,
  registry: ToolRegistry,
  namespace?: string,
): Array<Record<string, unknown>> =>
  tools.flatMap((tool): Array<Record<string, unknown>> => {
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const nestedNamespace =
        typeof tool.name === "string" ? tool.name : namespace;
      const nested = lowerToolDefinitions(
        tool.tools.filter(asRecord) as Array<Record<string, unknown>>,
        registry,
        nestedNamespace,
      );

      return nested.length > 0 ? [{ ...tool, tools: nested }] : [];
    }
    if (tool.type === "custom" && typeof tool.name === "string") {
      const key = toolKey(tool.name, namespace);

      rememberToolKind(registry, key, "custom");

      return [
        {
          type: "function",
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          ...(tool.defer_loading !== undefined
            ? { defer_loading: tool.defer_loading }
            : {}),
          strict: false,
          parameters: customToolParameters(tool.name),
        },
      ];
    }
    if (tool.type === "function") {
      rememberToolKind(registry, toolKey(tool.name, namespace), "function");

      return [
        {
          ...tool,
          parameters: normalizeObjectRootToolInputSchema(tool.parameters),
        },
      ];
    }
    if (tool.type === "web_search") {
      if (
        Object.hasOwn(tool, "external_web_access") &&
        tool.external_web_access !== true
      ) {
        return [];
      }
      const normalized = { ...tool };

      delete normalized.external_web_access;
      delete normalized.search_context_size;
      if (
        Array.isArray(normalized.search_content_types) &&
        normalized.search_content_types.includes("image")
      ) {
        normalized.enable_image_search = true;
      }

      return [normalized];
    }

    return [tool];
  });

const lowerInputItem = (
  item: Record<string, unknown>,
  registry: ToolRegistry,
): Record<string, unknown> | null => {
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    const tools = lowerToolDefinitions(
      item.tools.filter(asRecord) as Array<Record<string, unknown>>,
      registry,
    );

    return tools.length > 0 ? { ...item, tools } : null;
  }
  if (item.type === "custom_tool_call") {
    const key = toolKey(item.name, item.namespace);

    rememberToolKind(registry, key, "custom");

    return {
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      ...(typeof item.namespace === "string"
        ? { namespace: item.namespace }
        : {}),
      arguments: JSON.stringify({ input: item.input }),
    };
  }
  if (item.type === "custom_tool_call_output") {
    return {
      type: "function_call_output",
      call_id: item.call_id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      output: item.output,
    };
  }

  return item;
};

export interface XaiCodexCompatibilityRequest {
  customTools: ReadonlySet<string>;
  request: CodexResponsesRequest;
}

/** Lower Responses custom tools into the function-only Grok subscription wire. */
export function prepareXaiCodexCompatibilityRequest(
  request: CodexResponsesRequest,
): XaiCodexCompatibilityRequest {
  const registry: ToolRegistry = {
    custom: new Set<string>(),
    functions: new Set<string>(),
  };
  const tools = request.tools
    ? lowerToolDefinitions(request.tools, registry)
    : undefined;
  const input = request.input.flatMap((item) => {
    const lowered = lowerInputItem(item, registry);

    return lowered ? [lowered] : [];
  });
  const hasDeclaredTools =
    Boolean(tools?.length) ||
    input.some(
      (item) =>
        item.type === "additional_tools" &&
        Array.isArray(item.tools) &&
        item.tools.length > 0,
    );

  return {
    customTools: registry.custom,
    request: {
      ...request,
      input,
      ...(tools?.length ? { tools } : { tools: undefined }),
      ...(request.tool_choice === "required" && !hasDeclaredTools
        ? { tool_choice: "none" }
        : {}),
    },
  };
}

const customInput = (argumentsValue: unknown): string => {
  if (typeof argumentsValue !== "string")
    return JSON.stringify(argumentsValue) ?? "";

  try {
    const parsed = asRecord(JSON.parse(argumentsValue));

    return typeof parsed?.input === "string" ? parsed.input : argumentsValue;
  } catch {
    return argumentsValue;
  }
};

const rewriteCustomItem = (
  item: Record<string, unknown>,
  customTools: ReadonlySet<string>,
): Record<string, unknown> => {
  if (item.type !== "function_call") return item;
  const key = toolKey(item.name, item.namespace);

  if (!key || !customTools.has(key)) return item;

  return {
    type: "custom_tool_call",
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    call_id: item.call_id,
    name: item.name,
    ...(typeof item.namespace === "string"
      ? { namespace: item.namespace }
      : {}),
    input: customInput(item.arguments),
    status: typeof item.status === "string" ? item.status : "completed",
  };
};

async function* rewriteXaiFrames(
  upstream: ReadableStream<Uint8Array>,
  customTools: ReadonlySet<string>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const customItemIds = new Set<string>();

  for await (const frame of parseSseStream(upstream, signal)) {
    if (!frame.data || frame.data === "[DONE]") {
      yield encodeSseFrame(frame);
      continue;
    }
    const payload = asRecord(JSON.parse(frame.data));

    if (!payload) throw new TypeError("xAI Responses event must be an object");
    const item = asRecord(payload.item);
    const rewrittenItem = item ? rewriteCustomItem(item, customTools) : null;
    const itemId =
      typeof item?.id === "string"
        ? item.id
        : typeof item?.call_id === "string"
          ? item.call_id
          : null;
    const isCustomItem = rewrittenItem?.type === "custom_tool_call";

    if (isCustomItem && itemId) customItemIds.add(itemId);
    if (payload.type === "response.output_item.added" && isCustomItem) {
      continue;
    }
    if (
      (payload.type === "response.function_call_arguments.delta" ||
        payload.type === "response.function_call_arguments.done") &&
      ((typeof payload.item_id === "string" &&
        customItemIds.has(payload.item_id)) ||
        (typeof payload.call_id === "string" &&
          customItemIds.has(payload.call_id)))
    ) {
      continue;
    }
    let rewritten: Record<string, unknown> = rewrittenItem
      ? { ...payload, item: rewrittenItem }
      : payload;
    const response = asRecord(payload.response);

    if (response && Array.isArray(response.output)) {
      rewritten = {
        ...rewritten,
        response: {
          ...response,
          output: response.output.map((entry) => {
            const record = asRecord(entry);

            return record ? rewriteCustomItem(record, customTools) : entry;
          }),
        },
      };
    }

    yield encodeSseFrame({
      ...frame,
      data: JSON.stringify(rewritten),
    });
  }
}

/** Restore Codex custom-tool semantics after xAI emits a lowered function call. */
export function restoreXaiCodexCustomToolStream(
  upstream: ReadableStream<Uint8Array>,
  customTools: ReadonlySet<string>,
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const frames = rewriteXaiFrames(upstream, customTools, cancellation.signal);

  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await frames.next();

        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancellation.abort(reason);
      await frames.return(undefined);
    },
  });
}

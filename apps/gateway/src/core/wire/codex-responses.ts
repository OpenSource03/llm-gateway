import {
  JSON_MAX_STRING_LENGTH,
  assertAllowedKeys,
  assertBoundedJsonValue,
  isRecord,
} from "./validation";

export interface CodexResponsesRequest {
  model: string;
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice: string;
  parallel_tool_calls: boolean;
  reasoning?: {
    effort?: string;
    summary?: string;
    context?: string;
  };
  store: false;
  stream: true;
  stream_options?: { reasoning_summary_delivery?: string };
  include: string[];
  service_tier?: string;
  prompt_cache_key?: string;
  text?: Record<string, unknown>;
  client_metadata?: Record<string, string>;
}

export const codexGatewayModelId = (requestedModelId: string): string =>
  requestedModelId.includes("/")
    ? requestedModelId
    : `openai/${requestedModelId}`;

const MAX_INPUT_ITEMS = 10_000;
const MAX_TOOLS = 1_000;

const INPUT_ITEM_KEYS: Readonly<Record<string, readonly string[]>> = {
  additional_tools: ["id", "type", "role", "tools"],
  message: ["id", "type", "role", "content", "phase"],
  agent_message: ["id", "type", "author", "recipient", "content"],
  reasoning: ["id", "type", "summary", "content", "encrypted_content"],
  local_shell_call: ["id", "type", "call_id", "status", "action"],
  function_call: [
    "id",
    "type",
    "name",
    "namespace",
    "arguments",
    "encrypted_function_args",
    "call_id",
  ],
  tool_search_call: [
    "id",
    "type",
    "call_id",
    "status",
    "execution",
    "arguments",
  ],
  function_call_output: [
    "id",
    "type",
    "call_id",
    "name",
    "namespace",
    "output",
  ],
  custom_tool_call: [
    "id",
    "type",
    "status",
    "call_id",
    "name",
    "namespace",
    "input",
  ],
  custom_tool_call_output: ["id", "type", "call_id", "name", "output"],
  tool_search_output: ["id", "type", "call_id", "status", "execution", "tools"],
  web_search_call: ["id", "type", "status", "action"],
  image_generation_call: ["id", "type", "status", "revised_prompt", "result"],
  compaction: ["id", "type", "encrypted_content"],
  compaction_summary: ["id", "type", "encrypted_content"],
  compaction_trigger: ["type"],
  context_compaction: ["id", "type", "encrypted_content"],
};

const FUNCTION_TOOL_KEYS = [
  "type",
  "name",
  "description",
  "strict",
  "defer_loading",
  "parameters",
] as const;
const CUSTOM_TOOL_KEYS = [
  "type",
  "name",
  "description",
  "defer_loading",
  "format",
] as const;

const TOOL_KEYS: Readonly<Record<string, readonly string[]>> = {
  function: FUNCTION_TOOL_KEYS,
  namespace: ["type", "name", "description", "tools"],
  tool_search: ["type", "execution", "description", "parameters"],
  web_search: [
    "type",
    "external_web_access",
    "indexed_web_access",
    "filters",
    "user_location",
    "search_context_size",
    "search_content_types",
  ],
  custom: CUSTOM_TOOL_KEYS,
};

const MESSAGE_CONTENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  input_text: ["type", "text"],
  input_image: ["type", "image_url", "detail"],
  input_audio: ["type", "audio_url"],
  output_text: ["type", "text"],
};

const AGENT_MESSAGE_CONTENT_KEYS: Readonly<Record<string, readonly string[]>> =
  {
    input_text: ["type", "text"],
    encrypted_content: ["type", "encrypted_content"],
  };

const TOOL_OUTPUT_CONTENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  encrypted_content: ["type", "encrypted_content"],
  input_image: ["type", "image_url", "detail"],
  input_text: ["type", "text"],
  output_text: ["type", "text"],
  refusal: ["type", "refusal"],
  text: ["type", "text"],
};

const TOP_LEVEL_KEYS = [
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
] as const;

const reconstructedObject = (
  value: unknown,
  path: string,
  allowed: readonly string[],
  accepted: readonly string[] = allowed,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertAllowedKeys(value, path, accepted);
  assertBoundedJsonValue(value, path);

  return Object.fromEntries(
    allowed
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
};

function reconstructTypedArray(
  value: unknown,
  path: string,
  definitions: Readonly<Record<string, readonly string[]>>,
  maxItems: number,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (value.length > maxItems)
    throw new TypeError(`${path} contains too many entries`);

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.type !== "string")
      throw new TypeError(`${path}[${index}] must be a typed object`);
    const allowed = definitions[item.type];

    if (!allowed)
      throw new TypeError(`${path}[${index}].type is not supported`);

    return reconstructedObject(item, `${path}[${index}]`, allowed);
  });
}

function reconstructContentArray(
  value: unknown,
  path: string,
  definitions: Readonly<Record<string, readonly string[]>>,
): Array<Record<string, unknown>> {
  const content = reconstructTypedArray(
    value,
    path,
    definitions,
    MAX_INPUT_ITEMS,
  );

  for (const [index, item] of content.entries()) {
    const itemPath = `${path}[${index}]`;

    if (
      ["input_text", "output_text", "text"].includes(String(item.type)) &&
      typeof item.text !== "string"
    ) {
      throw new TypeError(`${itemPath}.text must be a string`);
    }
    if (
      item.type === "encrypted_content" &&
      typeof item.encrypted_content !== "string"
    ) {
      throw new TypeError(`${itemPath}.encrypted_content must be a string`);
    }
    if (item.type === "refusal" && typeof item.refusal !== "string") {
      throw new TypeError(`${itemPath}.refusal must be a string`);
    }
    if (
      item.type === "input_image" &&
      (typeof item.image_url !== "string" || !item.image_url)
    ) {
      throw new TypeError(`${itemPath}.image_url must be a non-empty string`);
    }
    if (
      item.type === "input_image" &&
      item.detail !== undefined &&
      !["auto", "low", "high", "original"].includes(String(item.detail))
    ) {
      throw new TypeError(`${itemPath}.detail is invalid`);
    }
    if (
      item.type === "input_audio" &&
      (typeof item.audio_url !== "string" || !item.audio_url)
    ) {
      throw new TypeError(`${itemPath}.audio_url must be a non-empty string`);
    }
  }

  return content;
}

const reconstructToolOutput = (
  value: unknown,
  path: string,
): string | Array<Record<string, unknown>> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length > JSON_MAX_STRING_LENGTH)
      throw new TypeError(`${path} contains an oversized string`);

    return value;
  }

  return reconstructContentArray(value, path, TOOL_OUTPUT_CONTENT_KEYS);
};

function reconstructToolList(
  value: unknown,
  path = "tools",
): Array<Record<string, unknown>> {
  const tools = reconstructTypedArray(value, path, TOOL_KEYS, MAX_TOOLS);

  return tools.map((tool, index) => {
    const pathForTool = `${path}[${index}]`;

    if (
      ["function", "custom", "namespace"].includes(String(tool.type)) &&
      (typeof tool.name !== "string" || !tool.name)
    ) {
      throw new TypeError(`${pathForTool}.name must be a non-empty string`);
    }
    if (
      tool.description !== undefined &&
      typeof tool.description !== "string"
    ) {
      throw new TypeError(`${pathForTool}.description must be a string`);
    }
    if (tool.type === "function") {
      if (!isRecord(tool.parameters))
        throw new TypeError(`${pathForTool}.parameters must be an object`);

      return tool;
    }
    if (tool.type === "custom") {
      const format = reconstructedObject(tool.format, `${pathForTool}.format`, [
        "type",
        "syntax",
        "definition",
      ]);

      if (
        typeof format.type !== "string" ||
        typeof format.syntax !== "string" ||
        typeof format.definition !== "string"
      ) {
        throw new TypeError(`${pathForTool}.format is invalid`);
      }

      return { ...tool, format };
    }
    if (tool.type !== "namespace") return tool;
    const nested = reconstructToolList(tool.tools, `${pathForTool}.tools`);

    if (
      nested.some((item) => !["function", "custom"].includes(String(item.type)))
    )
      throw new TypeError(`${pathForTool}.tools contains an invalid type`);

    return {
      ...tool,
      tools: nested,
    };
  });
}

const reconstructInput = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError("input must be a non-empty array");
  if (value.length > MAX_INPUT_ITEMS)
    throw new TypeError("input contains too many entries");

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.type !== "string")
      throw new TypeError(`input[${index}] must be a typed object`);
    const allowed = INPUT_ITEM_KEYS[item.type];

    if (!allowed) throw new TypeError(`input[${index}].type is not supported`);

    const reconstructed = reconstructedObject(
      item,
      `input[${index}]`,
      allowed,
      [
        ...allowed,
        // Codex uses this for its own transcript bookkeeping. It must never be
        // caller-controlled when the request is replayed through pooled auth.
        "internal_chat_message_metadata_passthrough",
      ],
    );

    if (reconstructed.type === "additional_tools") {
      reconstructed.tools = reconstructToolList(
        reconstructed.tools,
        `input[${index}].tools`,
      );
    }
    if (reconstructed.type === "message") {
      if (
        typeof reconstructed.role !== "string" ||
        !["user", "assistant", "developer", "system"].includes(
          reconstructed.role,
        )
      ) {
        throw new TypeError(`input[${index}].role is invalid`);
      }
      reconstructed.content = reconstructContentArray(
        reconstructed.content,
        `input[${index}].content`,
        MESSAGE_CONTENT_KEYS,
      );
    }
    if (reconstructed.type === "agent_message") {
      reconstructed.content = reconstructContentArray(
        reconstructed.content,
        `input[${index}].content`,
        AGENT_MESSAGE_CONTENT_KEYS,
      );
    }
    if (
      reconstructed.type === "function_call_output" ||
      reconstructed.type === "custom_tool_call_output"
    ) {
      reconstructed.output = reconstructToolOutput(
        reconstructed.output,
        `input[${index}].output`,
      );
    }
    if (reconstructed.type === "local_shell_call") {
      const action = reconstructedObject(
        reconstructed.action,
        `input[${index}].action`,
        ["type", "command", "timeout_ms", "working_directory", "env", "user"],
      );

      if (action.type !== "exec" || !Array.isArray(action.command))
        throw new TypeError(`input[${index}].action is invalid`);
      reconstructed.action = action;
    }

    return reconstructed;
  });
};

const reconstructTools = (
  value: unknown,
): Array<Record<string, unknown>> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("tools must be an array");
  if (value.length > MAX_TOOLS)
    throw new TypeError("tools contains too many entries");

  return reconstructToolList(value);
};

const optionalShortString = (
  value: unknown,
  path: string,
  max = 512,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > max)
    throw new TypeError(`${path} must be a non-empty string`);

  return value;
};

/**
 * Parse and reconstruct the current open-source Codex Responses request.
 * Unknown top-level, item, and tool fields are rejected rather than forwarded
 * through pooled subscription credentials.
 */
export function parseCodexResponsesRequest(
  value: unknown,
): CodexResponsesRequest {
  if (!isRecord(value)) throw new TypeError("Request must be an object");
  assertAllowedKeys(value, "request", TOP_LEVEL_KEYS);
  const model = optionalShortString(value.model, "model", 200);

  if (!model) throw new TypeError("model is required");
  const instructions = value.instructions ?? "";

  if (
    typeof instructions !== "string" ||
    instructions.length > JSON_MAX_STRING_LENGTH
  ) {
    throw new TypeError("instructions must be a bounded string");
  }
  if (value.stream !== true)
    throw new TypeError("stream must be true for Codex clients");
  if (value.store !== undefined && value.store !== false)
    throw new TypeError("store must be false");
  if (
    value.parallel_tool_calls !== undefined &&
    typeof value.parallel_tool_calls !== "boolean"
  ) {
    throw new TypeError("parallel_tool_calls must be a boolean");
  }
  const toolChoice = value.tool_choice ?? "auto";

  if (
    typeof toolChoice !== "string" ||
    !["auto", "none", "required"].includes(toolChoice)
  ) {
    throw new TypeError("tool_choice is invalid");
  }
  let reasoning: CodexResponsesRequest["reasoning"];

  if (value.reasoning !== undefined && value.reasoning !== null) {
    const record = reconstructedObject(value.reasoning, "reasoning", [
      "effort",
      "summary",
      "context",
    ]);
    const effort = optionalShortString(record.effort, "reasoning.effort", 32);
    const summary = optionalShortString(
      record.summary,
      "reasoning.summary",
      32,
    );
    const context = optionalShortString(
      record.context,
      "reasoning.context",
      32,
    );

    if (
      effort &&
      ![
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
        "disabled",
      ].includes(effort)
    ) {
      throw new TypeError("reasoning.effort is invalid");
    }
    if (summary && !["auto", "concise", "detailed"].includes(summary))
      throw new TypeError("reasoning.summary is invalid");
    if (context && !["current_turn", "all_turns"].includes(context))
      throw new TypeError("reasoning.context is invalid");
    reasoning = {
      ...(effort ? { effort } : {}),
      ...(summary ? { summary } : {}),
      ...(context ? { context } : {}),
    };
  }
  let streamOptions: CodexResponsesRequest["stream_options"];

  if (value.stream_options !== undefined) {
    const record = reconstructedObject(value.stream_options, "stream_options", [
      "reasoning_summary_delivery",
    ]);
    const delivery = optionalShortString(
      record.reasoning_summary_delivery,
      "stream_options.reasoning_summary_delivery",
      32,
    );

    if (delivery && !["sequential_cutoff"].includes(delivery))
      throw new TypeError(
        "stream_options.reasoning_summary_delivery is invalid",
      );
    streamOptions = delivery ? { reasoning_summary_delivery: delivery } : {};
  }
  const includeValue = value.include ?? [];

  if (
    !Array.isArray(includeValue) ||
    includeValue.length > 10 ||
    includeValue.some((item) => item !== "reasoning.encrypted_content")
  ) {
    throw new TypeError("include contains an unsupported value");
  }
  let text: Record<string, unknown> | undefined;

  if (value.text !== undefined) {
    text = reconstructedObject(value.text, "text", ["verbosity", "format"]);
    if (
      text.verbosity !== undefined &&
      !["low", "medium", "high"].includes(String(text.verbosity))
    ) {
      throw new TypeError("text.verbosity is invalid");
    }
    if (text.format !== undefined) {
      const format = reconstructedObject(text.format, "text.format", [
        "type",
        "strict",
        "schema",
        "name",
      ]);

      if (
        format.type !== "json_schema" ||
        typeof format.strict !== "boolean" ||
        !isRecord(format.schema) ||
        typeof format.name !== "string"
      ) {
        throw new TypeError("text.format is invalid");
      }
      text.format = format;
    }
  }
  let clientMetadata: Record<string, string> | undefined;

  if (value.client_metadata !== undefined) {
    if (!isRecord(value.client_metadata))
      throw new TypeError("client_metadata must be an object");
    const entries = Object.entries(value.client_metadata);

    if (entries.length > 64)
      throw new TypeError("client_metadata contains too many fields");
    clientMetadata = Object.fromEntries(
      entries.map(([key, entry]) => {
        if (
          key.length > 100 ||
          typeof entry !== "string" ||
          entry.length > 2_000
        ) {
          throw new TypeError("client_metadata contains an invalid field");
        }

        return [key, entry];
      }),
    );
  }
  const serviceTier = optionalShortString(
    value.service_tier,
    "service_tier",
    64,
  );

  if (
    serviceTier &&
    !["default", "priority", "fast", "flex"].includes(serviceTier)
  ) {
    throw new TypeError("service_tier is not supported by this gateway");
  }
  const canonicalServiceTier =
    serviceTier === "fast" ? "priority" : serviceTier;
  const promptCacheKey = optionalShortString(
    value.prompt_cache_key,
    "prompt_cache_key",
    512,
  );
  const tools = reconstructTools(value.tools);

  return {
    model,
    instructions,
    input: reconstructInput(value.input),
    ...(tools ? { tools } : {}),
    tool_choice: toolChoice,
    parallel_tool_calls: value.parallel_tool_calls === true,
    ...(reasoning ? { reasoning } : {}),
    store: false,
    stream: true,
    ...(streamOptions ? { stream_options: streamOptions } : {}),
    include: [...includeValue],
    ...(canonicalServiceTier ? { service_tier: canonicalServiceTier } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(text ? { text } : {}),
    ...(clientMetadata ? { client_metadata: clientMetadata } : {}),
  };
}

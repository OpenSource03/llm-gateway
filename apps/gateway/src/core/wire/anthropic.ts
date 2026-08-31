import {
  assertAllowedKeys,
  assertBoundedJsonValue,
  isRecord,
} from "./validation";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  [key: string]: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  caller?: { type: "direct" };
  cache_control?: unknown;
  [key: string]: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

export interface AnthropicToolReferenceBlock {
  type: "tool_reference";
  tool_name: string;
  [key: string]: unknown;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
  [key: string]: unknown;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicToolReferenceBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | ({ type: string } & Record<string, unknown>);

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  defer_loading?: boolean;
  [key: string]: unknown;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?:
    | { type: "enabled"; budget_tokens: number; display?: "omitted" }
    | { type: "adaptive"; display?: "omitted" }
    | { type: "disabled"; display?: "omitted" };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  context_management?: {
    edits: Array<
      | { type: "clear_thinking_20251015"; keep: "all" }
      | {
          type: "compact_20260112";
          trigger?: { type: "input_tokens"; value: number };
        }
    >;
  };
  /** Only effort is delegated; unadvertised structured formats stay local. */
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    format?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason:
    "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// Keep malformed or adversarial JSON numbers from turning into unbounded
// reservations/provider generations. A discovered model's lower advertised
// limit is enforced by the data plane after alias resolution.
export const MAX_ANTHROPIC_OUTPUT_TOKENS = 128_000;

export function assertAnthropicMessagesRequest(
  value: unknown,
  options: { allowMissingMaxTokens?: boolean } = {},
): asserts value is AnthropicMessagesRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Request must be an object");
  const request = value as Partial<AnthropicMessagesRequest>;

  assertAllowedKeys(request, "request", [
    "model",
    "messages",
    "max_tokens",
    "system",
    "stream",
    "tools",
    "tool_choice",
    "thinking",
    "temperature",
    "top_p",
    "stop_sequences",
    "metadata",
    "context_management",
    "output_config",
  ]);

  if (typeof request.model !== "string" || !request.model.trim())
    throw new TypeError("model is required");
  if (!Array.isArray(request.messages))
    throw new TypeError("messages must be an array");
  if (request.messages.length === 0)
    throw new TypeError("messages must not be empty");
  if (request.messages.length > 10_000)
    throw new TypeError("messages contains too many entries");
  for (const [index, message] of request.messages.entries()) {
    assertAnthropicMessage(message, `messages[${index}]`);
  }
  if (
    !(options.allowMissingMaxTokens && request.max_tokens === undefined) &&
    (!Number.isSafeInteger(request.max_tokens) ||
      Number(request.max_tokens) <= 0 ||
      Number(request.max_tokens) > MAX_ANTHROPIC_OUTPUT_TOKENS)
  ) {
    throw new TypeError(
      `max_tokens must be a positive safe integer no greater than ${MAX_ANTHROPIC_OUTPUT_TOKENS}`,
    );
  }
  if (request.system !== undefined) {
    if (typeof request.system !== "string" && !Array.isArray(request.system)) {
      throw new TypeError("system must be text or an array of text blocks");
    }
    if (Array.isArray(request.system)) {
      for (const [index, block] of request.system.entries()) {
        assertContentBlock(block, `system[${index}]`, { kind: "system" });
        if (block.type !== "text")
          throw new TypeError(`system[${index}] must be a text block`);
      }
    }
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools))
      throw new TypeError("tools must be an array");
    if (request.tools.length > 1_000)
      throw new TypeError("tools contains too many entries");
    const names = new Set<string>();

    for (const [index, tool] of request.tools.entries()) {
      if (!isRecord(tool)) throw new TypeError(`tools[${index}] is invalid`);
      assertAllowedKeys(tool, `tools[${index}]`, [
        "name",
        "description",
        "input_schema",
        "cache_control",
        "defer_loading",
      ]);
      if (typeof tool.name !== "string" || !tool.name.trim())
        throw new TypeError(`tools[${index}].name is required`);
      if (names.has(tool.name))
        throw new TypeError(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      if (!isRecord(tool.input_schema))
        throw new TypeError(`tools[${index}].input_schema must be an object`);
      assertBoundedJsonValue(tool.input_schema, `tools[${index}].input_schema`);
      assertCacheControl(tool.cache_control, `tools[${index}].cache_control`);
      if (
        tool.defer_loading !== undefined &&
        typeof tool.defer_loading !== "boolean"
      ) {
        throw new TypeError(`tools[${index}].defer_loading must be a boolean`);
      }
    }
  }
  if (request.tool_choice !== undefined) {
    if (!isRecord(request.tool_choice))
      throw new TypeError("tool_choice must be an object");
    assertAllowedKeys(request.tool_choice, "tool_choice", [
      "type",
      "name",
      "disable_parallel_tool_use",
    ]);
    if (!["auto", "any", "tool", "none"].includes(request.tool_choice.type))
      throw new TypeError("tool_choice.type is invalid");
    if (
      request.tool_choice.type === "tool" &&
      (typeof request.tool_choice.name !== "string" ||
        !request.tool_choice.name.trim())
    ) {
      throw new TypeError("tool_choice.name is required");
    }
    if (
      "disable_parallel_tool_use" in request.tool_choice &&
      request.tool_choice.disable_parallel_tool_use !== undefined &&
      typeof request.tool_choice.disable_parallel_tool_use !== "boolean"
    ) {
      throw new TypeError(
        "tool_choice.disable_parallel_tool_use must be a boolean",
      );
    }
  }
  if (request.thinking !== undefined) {
    if (!isRecord(request.thinking))
      throw new TypeError("thinking must be an object");
    assertAllowedKeys(request.thinking, "thinking", [
      "type",
      "budget_tokens",
      "display",
    ]);
    if (!["enabled", "adaptive", "disabled"].includes(request.thinking.type))
      throw new TypeError("thinking.type is invalid");
    if (
      request.thinking.type === "enabled" &&
      (!Number.isSafeInteger(request.thinking.budget_tokens) ||
        Number(request.thinking.budget_tokens) <= 0)
    ) {
      throw new TypeError("thinking.budget_tokens must be a positive integer");
    }
    if (
      request.thinking.display !== undefined &&
      request.thinking.display !== "omitted"
    ) {
      throw new TypeError("thinking.display is invalid");
    }
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean")
    throw new TypeError("stream must be a boolean");
  assertOptionalUnitInterval(request.temperature, "temperature");
  assertOptionalUnitInterval(request.top_p, "top_p");
  if (request.stop_sequences !== undefined) {
    if (
      !Array.isArray(request.stop_sequences) ||
      request.stop_sequences.length > 100 ||
      request.stop_sequences.some(
        (sequence) => typeof sequence !== "string" || !sequence,
      )
    ) {
      throw new TypeError(
        "stop_sequences must contain at most 100 non-empty strings",
      );
    }
  }
  if (request.metadata !== undefined && !isRecord(request.metadata))
    throw new TypeError("metadata must be an object");
  if (request.metadata !== undefined)
    assertBoundedJsonValue(request.metadata, "metadata");
  assertContextManagement(request.context_management);
  if (request.output_config !== undefined) {
    if (!isRecord(request.output_config)) {
      throw new TypeError("output_config must be an object");
    }
    assertAllowedKeys(request.output_config, "output_config", [
      "effort",
      "format",
    ]);
    if (
      request.output_config.effort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(
        String(request.output_config.effort),
      )
    ) {
      throw new TypeError("output_config.effort is invalid");
    }
    if (
      request.output_config.format !== undefined &&
      !isRecord(request.output_config.format)
    ) {
      throw new TypeError("output_config.format must be an object");
    }
    if (request.output_config.format !== undefined) {
      assertBoundedJsonValue(
        request.output_config.format,
        "output_config.format",
      );
    }
  }
  assertClaudeToolNamespace(request as AnthropicMessagesRequest);
}

const assertOptionalUnitInterval = (value: unknown, path: string): void => {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new TypeError(`${path} must be a finite number between 0 and 1`);
};

const assertCacheControl = (value: unknown, path: string): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertAllowedKeys(value, path, ["type", "ttl"]);
  if (value.type !== "ephemeral")
    throw new TypeError(`${path}.type must be ephemeral`);
  if (value.ttl !== undefined && !["5m", "1h"].includes(String(value.ttl)))
    throw new TypeError(`${path}.ttl is invalid`);
};

const assertContextManagement = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value))
    throw new TypeError("context_management must be an object");
  assertAllowedKeys(value, "context_management", ["edits"]);
  if (
    !Array.isArray(value.edits) ||
    value.edits.length === 0 ||
    value.edits.length > 8
  ) {
    throw new TypeError("context_management.edits must contain 1 to 8 edits");
  }
  for (const [index, edit] of value.edits.entries()) {
    const path = `context_management.edits[${index}]`;

    if (!isRecord(edit)) throw new TypeError(`${path} must be an object`);
    if (edit.type === "clear_thinking_20251015") {
      assertAllowedKeys(edit, path, ["type", "keep"]);
      if (edit.keep !== "all") throw new TypeError(`${path}.keep must be all`);
      continue;
    }
    if (edit.type === "compact_20260112") {
      assertAllowedKeys(edit, path, ["type", "trigger"]);
      if (edit.trigger === undefined) continue;
      if (!isRecord(edit.trigger))
        throw new TypeError(`${path}.trigger must be an object`);
      assertAllowedKeys(edit.trigger, `${path}.trigger`, ["type", "value"]);
      if (
        edit.trigger.type !== "input_tokens" ||
        !Number.isSafeInteger(edit.trigger.value) ||
        Number(edit.trigger.value) <= 0 ||
        Number(edit.trigger.value) > 10_000_000
      ) {
        throw new TypeError(`${path}.trigger is invalid`);
      }
      continue;
    }
    throw new TypeError(`${path}.type is unsupported`);
  }
};

const assertAnthropicMessage = (value: unknown, path: string): void => {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertAllowedKeys(value, path, ["role", "content"]);
  if (!["user", "assistant", "system"].includes(String(value.role)))
    throw new TypeError(`${path}.role is invalid`);
  if (typeof value.content === "string") return;
  if (!Array.isArray(value.content))
    throw new TypeError(`${path}.content must be text or an array`);
  if (value.content.length > 10_000)
    throw new TypeError(`${path}.content contains too many blocks`);
  for (const [index, block] of value.content.entries()) {
    assertContentBlock(block, `${path}.content[${index}]`, {
      kind: "message",
      role: value.role as AnthropicMessage["role"],
    });
  }
};

type ContentBlockContext =
  | { kind: "system" }
  | { kind: "message"; role: AnthropicMessage["role"] }
  | { kind: "tool-result" };

const isUserContent = (context: ContentBlockContext): boolean =>
  context.kind === "tool-result" ||
  (context.kind === "message" && context.role === "user");

const isAssistantMessage = (context: ContentBlockContext): boolean =>
  context.kind === "message" && context.role === "assistant";

const assertContentBlock = (
  value: unknown,
  path: string,
  context: ContentBlockContext,
): void => {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new TypeError(`${path} must be a typed object`);
  switch (value.type) {
    case "text":
      assertAllowedKeys(value, path, ["type", "text", "cache_control"]);
      if (typeof value.text !== "string")
        throw new TypeError(`${path}.text must be a string`);
      assertCacheControl(value.cache_control, `${path}.cache_control`);

      return;
    case "image": {
      assertAllowedKeys(value, path, ["type", "source", "cache_control"]);
      if (!isUserContent(context))
        throw new TypeError(`${path} images are only valid for user messages`);
      assertCacheControl(value.cache_control, `${path}.cache_control`);
      if (!isRecord(value.source))
        throw new TypeError(`${path}.source must be an object`);
      if (value.source.type === "base64") {
        assertAllowedKeys(value.source, `${path}.source`, [
          "type",
          "media_type",
          "data",
        ]);
        if (
          typeof value.source.media_type !== "string" ||
          !/^image\/(?:png|jpeg|gif|webp)$/i.test(value.source.media_type) ||
          typeof value.source.data !== "string" ||
          !value.source.data
        ) {
          throw new TypeError(`${path}.source base64 data is invalid`);
        }
      } else {
        assertAllowedKeys(value.source, `${path}.source`, ["type", "url"]);
        if (
          value.source.type !== "url" ||
          typeof value.source.url !== "string" ||
          !value.source.url
        ) {
          throw new TypeError(`${path}.source is invalid`);
        }
        let url: URL;

        try {
          url = new URL(value.source.url);
        } catch {
          throw new TypeError(`${path}.source.url must be a valid HTTPS URL`);
        }
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new TypeError(`${path}.source.url must be a valid HTTPS URL`);
        }
      }

      return;
    }
    case "tool_use":
      assertAllowedKeys(value, path, [
        "type",
        "id",
        "name",
        "input",
        "caller",
        "cache_control",
      ]);
      if (!isAssistantMessage(context))
        throw new TypeError(`${path} tool_use requires assistant role`);
      if (
        typeof value.id !== "string" ||
        !value.id ||
        typeof value.name !== "string" ||
        !value.name ||
        !isRecord(value.input)
      ) {
        throw new TypeError(`${path} tool_use id/name/input is invalid`);
      }
      assertBoundedJsonValue(value.input, `${path}.input`);
      assertCacheControl(value.cache_control, `${path}.cache_control`);
      if (value.caller !== undefined) {
        if (!isRecord(value.caller))
          throw new TypeError(`${path}.caller must be an object`);
        assertAllowedKeys(value.caller, `${path}.caller`, ["type"]);
        if (value.caller.type !== "direct")
          throw new TypeError(`${path}.caller.type is unsupported`);
      }

      return;
    case "tool_result":
      assertAllowedKeys(value, path, [
        "type",
        "tool_use_id",
        "content",
        "is_error",
        "cache_control",
      ]);
      if (context.kind !== "message" || context.role !== "user")
        throw new TypeError(`${path} tool_result requires user role`);
      if (typeof value.tool_use_id !== "string" || !value.tool_use_id)
        throw new TypeError(`${path}.tool_use_id is required`);
      if (value.is_error !== undefined && typeof value.is_error !== "boolean")
        throw new TypeError(`${path}.is_error must be a boolean`);
      assertCacheControl(value.cache_control, `${path}.cache_control`);
      if (
        value.content !== undefined &&
        typeof value.content !== "string" &&
        !Array.isArray(value.content)
      ) {
        throw new TypeError(`${path}.content is invalid`);
      }
      if (Array.isArray(value.content)) {
        for (const [index, block] of value.content.entries()) {
          if (
            !isRecord(block) ||
            !["text", "image", "tool_reference"].includes(String(block.type))
          ) {
            throw new TypeError(
              `${path}.content[${index}] must be a text, image, or tool reference block`,
            );
          }
          assertContentBlock(block, `${path}.content[${index}]`, {
            kind: "tool-result",
          });
        }
      }

      return;
    case "tool_reference":
      assertAllowedKeys(value, path, ["type", "tool_name"]);
      if (
        context.kind !== "tool-result" ||
        typeof value.tool_name !== "string" ||
        !value.tool_name ||
        value.tool_name.length > 512
      ) {
        throw new TypeError(`${path}.tool_name is invalid`);
      }

      return;
    case "thinking":
      assertAllowedKeys(value, path, ["type", "thinking", "signature"]);
      if (!isAssistantMessage(context))
        throw new TypeError(`${path} thinking requires assistant role`);
      if (typeof value.thinking !== "string")
        throw new TypeError(`${path}.thinking must be a string`);

      return;
    case "redacted_thinking":
      assertAllowedKeys(value, path, ["type", "data"]);
      if (!isAssistantMessage(context))
        throw new TypeError(
          `${path} redacted_thinking requires assistant role`,
        );
      if (typeof value.data !== "string")
        throw new TypeError(`${path}.data must be a string`);

      return;
    default:
      throw new TypeError(`${path}.type is unsupported`);
  }
};

const claudeNamespacedToolName = (name: string): string =>
  name.startsWith("mcp_")
    ? name
    : `mcp_${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * Claude Code rewrites tool names before signing the upstream body. Reject a
 * request whose distinct public names collapse to the same upstream name so
 * the collision is a client 400 rather than an account-health failure.
 */
const assertClaudeToolNamespace = (request: AnthropicMessagesRequest): void => {
  const names = new Map<string, string>();
  const remember = (name: string): void => {
    const upstream = claudeNamespacedToolName(name);
    const existing = names.get(upstream);

    if (existing !== undefined && existing !== name) {
      throw new TypeError(
        `Tool names '${existing}' and '${name}' collide after Claude namespacing`,
      );
    }
    names.set(upstream, name);
  };

  for (const tool of request.tools ?? []) remember(tool.name);
  if (request.tool_choice?.type === "tool") remember(request.tool_choice.name);
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string")
        remember(block.name);
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (
            nested.type === "tool_reference" &&
            typeof nested.tool_name === "string"
          ) {
            remember(nested.tool_name);
          }
        }
      }
    }
  }
};

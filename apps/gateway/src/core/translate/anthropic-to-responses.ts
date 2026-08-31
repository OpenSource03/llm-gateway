import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicToolResultBlock,
} from "../wire/anthropic";
import type {
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesRequest,
} from "../wire/responses";

export interface AnthropicToResponsesOptions {
  model: string;
  provider: "openai" | "xai";
  sessionId?: string;
  omitMaxOutputTokens?: boolean;
  supportsReasoningEffort?: boolean;
}

export class UnsupportedAnthropicContentError extends Error {
  constructor(
    readonly contentType: string,
    message?: string,
  ) {
    super(message ?? `Unsupported Anthropic content block: ${contentType}`);
    this.name = "UnsupportedAnthropicContentError";
  }
}

/** Pure conversion from the gateway's Anthropic surface to Responses wire format. */
export function anthropicToResponses(
  request: AnthropicMessagesRequest,
  options: AnthropicToResponsesOptions,
): ResponsesRequest {
  const instructions: string[] = systemText(request.system);
  const input: ResponsesInputItem[] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      instructions.push(...contentText(message.content));
      continue;
    }
    const blocks: AnthropicContentBlock[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const role: "user" | "assistant" =
      message.role === "assistant" ? "assistant" : "user";
    let messageParts: ResponsesInputContent[] = [];
    const flushMessage = () => {
      if (messageParts.length === 0) return;
      input.push({
        type: "message",
        role,
        content: messageParts,
      });
      messageParts = [];
    };

    for (const block of blocks) {
      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text : "";

        if (text) {
          messageParts.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text,
          });
        }
        continue;
      }
      if (block.type === "image") {
        if (message.role !== "user") {
          throw new UnsupportedAnthropicContentError(
            "image",
            "Assistant image history cannot be represented safely",
          );
        }
        messageParts.push({
          type: "input_image",
          image_url: imageDataUrl(block as AnthropicImageBlock),
        });
        continue;
      }
      if (block.type === "tool_use") {
        if (message.role !== "assistant") {
          throw new UnsupportedAnthropicContentError(
            "tool_use",
            "tool_use is only valid in assistant messages",
          );
        }
        flushMessage();
        input.push({
          type: "function_call",
          call_id: requiredString(block.id, "tool_use.id"),
          name: requiredString(block.name, "tool_use.name"),
          arguments: stableJson(block.input ?? {}),
        });
        continue;
      }
      if (block.type === "tool_result") {
        if (message.role !== "user") {
          throw new UnsupportedAnthropicContentError(
            "tool_result",
            "tool_result is only valid in user messages",
          );
        }
        flushMessage();
        const normalized = toolResultOutput(block as AnthropicToolResultBlock);

        input.push({
          type: "function_call_output",
          call_id: requiredString(block.tool_use_id, "tool_result.tool_use_id"),
          output: normalized.text,
        });
        if (normalized.images.length > 0) {
          input.push({
            type: "message",
            role: "user",
            content: normalized.images.map((image_url) => ({
              type: "input_image",
              image_url,
            })),
          });
        }
        continue;
      }
      // Provider reasoning cannot be safely replayed from an Anthropic signature.
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      throw new UnsupportedAnthropicContentError(block.type);
    }
    flushMessage();
  }

  const response: ResponsesRequest = {
    model: options.model,
    input,
    stream: true,
  };

  if (instructions.length > 0)
    response.instructions = instructions.join("\n\n");
  if (request.tools?.length) {
    response.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: sortJson(tool.input_schema) as Record<string, unknown>,
      strict: false,
    }));
  }
  if (request.tool_choice)
    response.tool_choice = mapToolChoice(request.tool_choice);
  if (!options.omitMaxOutputTokens)
    response.max_output_tokens = request.max_tokens;
  if (options.sessionId) response.prompt_cache_key = options.sessionId;

  const effort = reasoningEffort(request);

  if (effort && options.supportsReasoningEffort !== false) {
    response.reasoning = { effort, summary: "auto" };
    response.include = ["reasoning.encrypted_content"];
  }

  if (options.provider === "xai") sanitizeXaiRequest(response, options.model);

  return response;
}

function systemText(system: AnthropicMessagesRequest["system"]): string[] {
  if (typeof system === "string") return system ? [system] : [];
  if (!Array.isArray(system)) return [];

  return system
    .filter(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0,
    )
    .map((block) => block.text);
}

function contentText(content: string | AnthropicContentBlock[]): string[] {
  if (typeof content === "string") return content ? [content] : [];

  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .filter(Boolean);
}

function imageDataUrl(block: AnthropicImageBlock): string {
  const source = block.source;

  if (!source || typeof source !== "object")
    throw new UnsupportedAnthropicContentError("image");
  if (source.type === "base64") {
    const mediaType = requiredString(
      source.media_type,
      "image.source.media_type",
    );
    const data = requiredString(source.data, "image.source.data");

    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(mediaType)) {
      throw new UnsupportedAnthropicContentError(
        "image",
        `Unsupported image media type: ${mediaType}`,
      );
    }

    return `data:${mediaType};base64,${data}`;
  }
  if (source.type === "url") {
    const raw = requiredString(source.url, "image.source.url");
    const url = new URL(raw);

    if (url.protocol !== "https:")
      throw new UnsupportedAnthropicContentError(
        "image",
        "Only HTTPS image URLs are accepted",
      );

    return url.toString();
  }
  throw new UnsupportedAnthropicContentError("image");
}

function toolResultOutput(block: AnthropicToolResultBlock): {
  text: string;
  images: string[];
} {
  if (typeof block.content === "string") {
    return {
      text: block.is_error ? `[tool_error]\n${block.content}` : block.content,
      images: [],
    };
  }
  const text: string[] = [];
  const images: string[] = [];

  for (const item of block.content ?? []) {
    if (item.type === "text" && typeof item.text === "string")
      text.push(item.text);
    else if (item.type === "image")
      images.push(imageDataUrl(item as AnthropicImageBlock));
    else if (item.type !== "thinking" && item.type !== "redacted_thinking") {
      text.push(stableJson(item));
    }
  }
  const joined = text.join("\n");

  return { text: block.is_error ? `[tool_error]\n${joined}` : joined, images };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${field} is required`);

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function mapToolChoice(
  choice: NonNullable<AnthropicMessagesRequest["tool_choice"]>,
): ResponsesRequest["tool_choice"] {
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", name: choice.name };

  return choice.type;
}

function reasoningEffort(
  request: AnthropicMessagesRequest,
): string | undefined {
  if (request.output_config?.effort) return request.output_config.effort;
  if (!request.thinking || request.thinking.type === "disabled")
    return undefined;
  if (request.thinking.type === "adaptive") return "high";
  const budget = request.thinking.budget_tokens;

  if (budget <= 2_048) return "low";
  if (budget <= 8_192) return "medium";
  if (budget <= 24_576) return "high";

  return "xhigh";
}

const XAI_REASONING_PREFIXES = [
  "grok-3-mini",
  "grok-4.20-multi-agent",
  "grok-4.3",
  "grok-4.5",
];

function sanitizeXaiRequest(request: ResponsesRequest, model: string): void {
  delete request.seed;
  delete request.parallel_tool_calls;
  delete request.service_tier;
  delete request.prompt_cache_retention;
  if (
    !XAI_REASONING_PREFIXES.some((prefix) =>
      model.toLowerCase().startsWith(prefix),
    )
  ) {
    delete request.reasoning;
    delete request.include;
  }
  // xAI rejects enum values containing slash characters in function schemas.
  for (const tool of request.tools ?? []) stripSlashEnums(tool.parameters);
}

function stripSlashEnums(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripSlashEnums(item);

    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;

  if (
    Array.isArray(record.enum) &&
    record.enum.some((item) => typeof item === "string" && item.includes("/"))
  ) {
    delete record.enum;
  }
  for (const item of Object.values(record)) stripSlashEnums(item);
}

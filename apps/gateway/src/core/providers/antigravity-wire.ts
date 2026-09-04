import type {
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  AnthropicToolChoice,
  AnthropicUsage,
} from "../wire/anthropic";

import { createHash, randomUUID } from "node:crypto";

import { aggregateAnthropicSse } from "../translate/responses-to-anthropic";
import { encodeSseEvent, parseSseStream } from "../wire/sse";

import {
  isRecord,
  mergeHeadersForPublicResponse,
  ProviderProtocolError,
  stableUuid,
} from "./shared";

const GOOGLE_FUNCTION_NAME_LIMIT = 64;
const INVALID_FUNCTION_CHARACTER = /[^A-Za-z0-9_.-]/g;
const GEMINI_SIGNATURE_BYPASS = "skip_thought_signature_validator";
const PUBLIC_STREAM_ERROR_MESSAGE = "Upstream provider request failed";

interface AntigravityPart extends Record<string, unknown> {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    id: string;
    name: string;
    response: { result: unknown };
    parts?: AntigravityPart[];
  };
}

interface AntigravityContent {
  role: "user" | "model";
  parts: AntigravityPart[];
}

interface AntigravityRequestEnvelope {
  project: string;
  requestId: string;
  request: {
    contents: AntigravityContent[];
    systemInstruction?: AntigravityContent;
    tools?: Array<{
      functionDeclarations: Array<{
        name: string;
        description?: string;
        parametersJsonSchema: Record<string, unknown>;
      }>;
    }>;
    toolConfig?: {
      functionCallingConfig: {
        mode: "AUTO" | "ANY" | "NONE";
        allowedFunctionNames?: string[];
      };
    };
    labels: {
      last_step_index: string;
      trajectory_id: string;
      used_claude: "true" | "false";
      used_claude_conservative: "true" | "false";
      used_non_gemini_model: "true" | "false";
    };
    generationConfig?: Record<string, unknown>;
    sessionId: string;
  };
  model: string;
  userAgent: "antigravity";
  requestType: "agent";
}

export interface AntigravityWireRequest {
  body: string;
  toolNames: ReadonlyMap<string, string>;
}

export interface AntigravityResponseOptions {
  publicModel: string;
  requestStream: boolean;
  toolNames: ReadonlyMap<string, string>;
}

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${path} must be a non-empty string`);

  return value;
};

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const wireToolName = (name: string, collisionAttempt = 0): string => {
  let normalized = name.replace(INVALID_FUNCTION_CHARACTER, "_");

  if (!/^[A-Za-z_]/.test(normalized)) normalized = `_${normalized}`;
  if (!normalized) normalized = "tool";
  const suffix = collisionAttempt
    ? `_${shortHash(`${name}\0${collisionAttempt}`)}`
    : "";

  if (normalized.length + suffix.length <= GOOGLE_FUNCTION_NAME_LIMIT)
    return `${normalized}${suffix}`;
  const truncationSuffix = `_${shortHash(
    collisionAttempt ? `${name}\0${collisionAttempt}` : name,
  )}`;

  return `${normalized.slice(
    0,
    GOOGLE_FUNCTION_NAME_LIMIT - truncationSuffix.length,
  )}${truncationSuffix}`;
};

class AntigravityToolNames {
  readonly #originalByWire = new Map<string, string>();
  readonly #wireByOriginal = new Map<string, string>();

  wire(original: string): string {
    const existing = this.#wireByOriginal.get(original);

    if (existing) return existing;
    let attempt = 0;
    let candidate: string;

    do candidate = wireToolName(original, attempt++);
    while (this.#originalByWire.has(candidate));
    this.#wireByOriginal.set(original, candidate);
    this.#originalByWire.set(candidate, original);

    return candidate;
  }

  entries(): ReadonlyMap<string, string> {
    return new Map(this.#originalByWire);
  }
}

const systemParts = (
  system: AnthropicMessagesRequest["system"],
): AntigravityPart[] => {
  if (typeof system === "string") return system ? [{ text: system }] : [];
  if (!Array.isArray(system)) return [];

  return system.flatMap((block) =>
    block.type === "text" && typeof block.text === "string" && block.text
      ? [{ text: block.text }]
      : [],
  );
};

const imagePart = (block: Record<string, unknown>): AntigravityPart => {
  const source = isRecord(block.source) ? block.source : null;

  if (
    source?.type !== "base64" ||
    typeof source.media_type !== "string" ||
    !/^image\/(?:png|jpeg|gif|webp)$/i.test(source.media_type) ||
    typeof source.data !== "string" ||
    !source.data
  ) {
    // Fetching arbitrary client URLs in the credentialed provider adapter
    // would turn image support into an SSRF surface. Clients should inline the
    // image bytes instead.
    throw new TypeError("Google image input must use an inline base64 source");
  }

  return {
    inlineData: { mimeType: source.media_type, data: source.data },
  };
};

const toolResult = (
  content: unknown,
): { result: unknown; images: AntigravityPart[] } => {
  if (typeof content === "string") return { result: content, images: [] };
  if (!Array.isArray(content)) return { result: "", images: [] };
  const values: unknown[] = [];
  const images: AntigravityPart[] = [];

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === "image") {
      images.push(imagePart(raw));
    } else if (raw.type === "text" && typeof raw.text === "string") {
      values.push(raw.text);
    } else if (raw.type !== "thinking" && raw.type !== "redacted_thinking") {
      values.push(raw);
    }
  }

  return {
    result: values.length <= 1 ? (values[0] ?? "") : values,
    images,
  };
};

function sanitizeSchema(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new TypeError("Tool schema is too deeply nested");
  if (Array.isArray(value))
    return value.map((item) => sanitizeSchema(item, depth + 1));
  if (!isRecord(value)) return value;
  const schema = value;
  const result: Record<string, unknown> = {};
  const type = schema.type;

  if (Array.isArray(type)) {
    const nonNull = type.filter((item) => item !== "null");

    if (nonNull.length === 1) result.type = nonNull[0];
    if (nonNull.length !== type.length) result.nullable = true;
  } else if (typeof type === "string") {
    result.type = type;
  }
  for (const key of [
    "description",
    "nullable",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ]) {
    if (schema[key] !== undefined) result[key] = schema[key];
  }
  if (Array.isArray(schema.enum)) result.enum = [...schema.enum];
  if (schema.const !== undefined && result.enum === undefined)
    result.enum = [schema.const];
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (isRecord(schema.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, item]) => [
        key,
        sanitizeSchema(item, depth + 1),
      ]),
    );
  }
  if (schema.items !== undefined)
    result.items = sanitizeSchema(schema.items, depth + 1);
  if (Array.isArray(schema.anyOf))
    result.anyOf = schema.anyOf.map((item) => sanitizeSchema(item, depth + 1));

  return result;
}

const generationConfig = (
  request: AnthropicMessagesRequest,
  options: { omitMaxOutputTokens: boolean },
): Record<string, unknown> | undefined => {
  const config: Record<string, unknown> = {};

  if (request.temperature !== undefined)
    config.temperature = request.temperature;
  if (request.top_p !== undefined) config.topP = request.top_p;
  if (request.stop_sequences?.length)
    config.stopSequences = [...request.stop_sequences];
  // Antigravity's Gemini lanes select their output policy from the live model
  // route and reject a client maxOutputTokens override. Claude/GPT lanes still
  // accept the field and use it to bound generation.
  if (request.max_tokens && !options.omitMaxOutputTokens)
    config.maxOutputTokens = request.max_tokens;
  if (request.thinking?.type === "enabled") {
    config.thinkingConfig = {
      thinkingBudget: request.thinking.budget_tokens,
    };
  } else if (request.thinking?.type === "adaptive") {
    config.thinkingConfig = {
      thinkingLevel: normalizeThinkingLevel(request.output_config?.effort),
    };
  }

  return Object.keys(config).length > 0 ? config : undefined;
};

const normalizeThinkingLevel = (
  effort: string | undefined,
): "low" | "medium" | "high" => {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";

  return "high";
};

const functionCallingConfig = (
  choice: AnthropicToolChoice | undefined,
  names: AntigravityToolNames,
): AntigravityRequestEnvelope["request"]["toolConfig"] => {
  if (!choice || choice.type === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (choice.type === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (choice.type === "tool") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [names.wire(choice.name)],
      },
    };
  }

  return { functionCallingConfig: { mode: "ANY" } };
};

const stableSessionId = (sessionId: string): string => {
  const bytes = createHash("sha256").update(sessionId).digest().subarray(0, 8);
  const value = bytes.readBigUInt64BE() & 0x7fffffffffffffffn;

  return `-${value || 1n}`;
};

const requestStepCount = (contents: AntigravityContent[]): number =>
  Math.max(
    1,
    contents.length +
      contents.reduce(
        (count, content) =>
          count +
          content.parts.filter((part) => part.functionResponse !== undefined)
            .length,
        0,
      ),
  );

const requestMetadata = (
  contents: AntigravityContent[],
  model: string,
  sessionId: string,
  timestamp: number,
) => {
  const conversationId = stableUuid(`antigravity:${sessionId}:conversation`);
  const trajectoryId = stableUuid(`antigravity:${sessionId}:trajectory`);
  const lastStepIndex = requestStepCount(contents);
  const claude = /(?:^|[-_.])claude(?:[-_.]|$)/i.test(model);
  const nonGemini = claude || /(?:^|[-_.])gpt(?:[-_.]|$)/i.test(model);

  return {
    requestId: `agent/${conversationId}/${timestamp}/${trajectoryId}/${lastStepIndex + 1}`,
    labels: {
      last_step_index: String(lastStepIndex),
      trajectory_id: trajectoryId,
      used_claude: claude ? ("true" as const) : ("false" as const),
      used_claude_conservative: claude ? ("true" as const) : ("false" as const),
      used_non_gemini_model: nonGemini ? ("true" as const) : ("false" as const),
    },
  };
};

const appendContent = (
  contents: AntigravityContent[],
  role: AntigravityContent["role"],
  parts: AntigravityPart[],
): void => {
  if (parts.length === 0) return;
  const previous = contents.at(-1);

  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
};

const providerLineageId = (
  sessionId: string,
  request: AnthropicMessagesRequest,
): string => {
  const firstUserTurn = request.messages.find(
    (message) => message.role === "user",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(firstUserTurn?.content ?? ""))
    .digest("hex");

  // Claude Code can issue title/helper calls beside the primary turn under one
  // public session header. Antigravity permits account concurrency but rejects
  // overlapping work on one provider trajectory, so stable semantic lineages
  // must not share that trajectory.
  return stableUuid(`antigravity:${sessionId}:${fingerprint}`);
};

const contentParts = (
  blocks: string | AnthropicContentBlock[],
  role: "user" | "assistant",
  names: AntigravityToolNames,
  toolNameById: Map<string, string>,
  geminiModel: boolean,
): AntigravityPart[] => {
  if (typeof blocks === "string") return blocks ? [{ text: blocks }] : [];
  const parts: AntigravityPart[] = [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text) parts.push({ text: block.text });
      continue;
    }
    if (block.type === "image") {
      if (role !== "user")
        throw new TypeError("Assistant image history is not supported");
      parts.push(imagePart(block));
      continue;
    }
    if (block.type === "thinking") {
      if (role !== "assistant" || typeof block.thinking !== "string") continue;
      if (!block.thinking && typeof block.signature !== "string") continue;
      parts.push({
        text: block.thinking,
        thought: true,
        ...(typeof block.signature === "string" && block.signature
          ? { thoughtSignature: block.signature }
          : {}),
      });
      continue;
    }
    if (block.type === "redacted_thinking") continue;
    if (block.type === "tool_use") {
      if (role !== "assistant")
        throw new TypeError("tool_use is only valid in assistant messages");
      const id = requiredString(block.id, "tool_use.id");
      const originalName = requiredString(block.name, "tool_use.name");
      const signature =
        typeof block.signature === "string" && block.signature
          ? block.signature
          : geminiModel
            ? GEMINI_SIGNATURE_BYPASS
            : undefined;

      toolNameById.set(id, originalName);
      parts.push({
        functionCall: {
          id,
          name: names.wire(originalName),
          args: isRecord(block.input) ? block.input : {},
        },
        ...(signature ? { thoughtSignature: signature } : {}),
      });
      continue;
    }
    if (block.type === "tool_result") {
      if (role !== "user")
        throw new TypeError("tool_result is only valid in user messages");
      const id = requiredString(block.tool_use_id, "tool_result.tool_use_id");
      const originalName = toolNameById.get(id) ?? id;
      const result = toolResult(block.content);

      parts.push({
        functionResponse: {
          id,
          name: names.wire(originalName),
          response: {
            result: block.is_error ? { error: result.result } : result.result,
          },
          ...(result.images.length ? { parts: result.images } : {}),
        },
      });
      continue;
    }
    throw new TypeError(`Unsupported Google content block: ${block.type}`);
  }

  return parts;
};

/** Convert the gateway's bounded Anthropic surface to Antigravity wire JSON. */
export function buildAntigravityRequest(input: {
  request: AnthropicMessagesRequest;
  upstreamModel: string;
  projectId: string;
  sessionId: string;
  timestamp: number;
}): AntigravityWireRequest {
  const names = new AntigravityToolNames();
  const toolNameById = new Map<string, string>();
  const contents: AntigravityContent[] = [];
  const system = systemParts(input.request.system);
  const geminiModel = /(?:^|[-_.])gemini(?:[-_.]|$)/i.test(input.upstreamModel);

  for (const message of input.request.messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") {
        if (message.content) system.push({ text: message.content });
      } else {
        for (const block of message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            system.push({ text: block.text });
          }
        }
      }
      continue;
    }
    appendContent(
      contents,
      message.role === "assistant" ? "model" : "user",
      contentParts(
        message.content,
        message.role === "assistant" ? "assistant" : "user",
        names,
        toolNameById,
        geminiModel,
      ),
    );
  }
  if (contents.length === 0)
    throw new TypeError("Google request has no supported message content");
  if (contents.at(-1)?.role === "model") {
    contents.push({ role: "user", parts: [{ text: "(continue)" }] });
  }
  const tools = (input.request.tools ?? []).map((tool) => ({
    name: names.wire(tool.name),
    ...(tool.description ? { description: tool.description } : {}),
    parametersJsonSchema: sanitizeSchema(tool.input_schema) as Record<
      string,
      unknown
    >,
  }));
  const generation = generationConfig(input.request, {
    omitMaxOutputTokens: geminiModel,
  });
  const lineageId = providerLineageId(input.sessionId, input.request);
  const metadata = requestMetadata(
    contents,
    input.upstreamModel,
    lineageId,
    input.timestamp,
  );
  const envelope: AntigravityRequestEnvelope = {
    project: input.projectId,
    requestId: metadata.requestId,
    request: {
      contents,
      ...(system.length
        ? { systemInstruction: { role: "user", parts: system } }
        : {}),
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      ...(tools.length
        ? {
            toolConfig: functionCallingConfig(input.request.tool_choice, names),
          }
        : {}),
      labels: metadata.labels,
      ...(generation ? { generationConfig: generation } : {}),
      sessionId: stableSessionId(lineageId),
    },
    model: input.upstreamModel,
    userAgent: "antigravity",
    requestType: "agent",
  };

  return { body: JSON.stringify(envelope), toolNames: names.entries() };
}

const finiteTokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const finishReason = (value: unknown, sawTool: boolean) => {
  if (sawTool) return "tool_use" as const;
  if (value === "MAX_TOKENS") return "max_tokens" as const;
  if (value === "SAFETY" || value === "RECITATION" || value === "BLOCKLIST")
    return "refusal" as const;

  return "end_turn" as const;
};

async function* antigravityFrames(
  upstream: ReadableStream<Uint8Array>,
  options: Pick<AntigravityResponseOptions, "publicModel" | "toolNames">,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let started = false;
  let finished = false;
  let responseId = `msg_${randomUUID().replaceAll("-", "")}`;
  let model = options.publicModel;
  let active: { index: number; type: "text" | "thinking" } | undefined;
  let nextIndex = 0;
  let sawTool = false;
  let terminalReason: unknown;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  const start = () => {
    if (started) return [];
    started = true;

    return [
      encodeSseEvent("message_start", {
        type: "message_start",
        message: {
          id: responseId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      }),
    ];
  };
  const closeActive = () => {
    if (!active) return [];
    const index = active.index;

    active = undefined;

    return [
      encodeSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    ];
  };
  const ensureBlock = (type: "text" | "thinking") => {
    if (active?.type === type) return [];
    const output = closeActive();
    const index = nextIndex++;

    active = { index, type };
    output.push(
      encodeSseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block:
          type === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "", signature: "" },
      }),
    );

    return output;
  };
  const finish = () => {
    if (finished) return [];
    finished = true;
    const output = [...start(), ...closeActive()];

    output.push(
      encodeSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: finishReason(terminalReason, sawTool),
          stop_sequence: null,
        },
        usage,
      }),
      encodeSseEvent("message_stop", { type: "message_stop" }),
    );

    return output;
  };

  try {
    for await (const frame of parseSseStream(upstream, signal)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const payload = JSON.parse(frame.data) as unknown;
      const root = isRecord(payload) ? payload : null;

      if (!root) throw new TypeError("Google stream event must be an object");
      if (root.error !== undefined) {
        for (const chunk of start()) yield chunk;
        yield encodeSseEvent("error", {
          type: "error",
          error: {
            type: "api_error",
            message: PUBLIC_STREAM_ERROR_MESSAGE,
          },
        });

        return;
      }
      const response = isRecord(root.response) ? root.response : root;
      const candidate = Array.isArray(response.candidates)
        ? response.candidates.find(isRecord)
        : undefined;
      const content =
        candidate && isRecord(candidate.content) ? candidate.content : null;
      const parts = Array.isArray(content?.parts)
        ? content.parts.filter(isRecord)
        : [];

      responseId = textValue(response.responseId) ?? responseId;
      model = textValue(response.modelVersion) ?? model;
      const usageMetadata = isRecord(response.usageMetadata)
        ? response.usageMetadata
        : null;

      if (usageMetadata) {
        const prompt = finiteTokenCount(usageMetadata.promptTokenCount);
        const cached = finiteTokenCount(usageMetadata.cachedContentTokenCount);
        const visibleOutput = finiteTokenCount(
          usageMetadata.candidatesTokenCount,
        );
        const reasoning = finiteTokenCount(usageMetadata.thoughtsTokenCount);
        const total = finiteTokenCount(usageMetadata.totalTokenCount);
        const output = visibleOutput + reasoning || Math.max(0, total - prompt);

        usage = {
          input_tokens: Math.max(0, prompt - cached),
          output_tokens: output,
          ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
        };
      }
      for (const chunk of start()) yield chunk;
      for (const part of parts) {
        const text = typeof part.text === "string" ? part.text : undefined;
        const signature = textValue(
          part.thoughtSignature ?? part.thought_signature,
        );
        const thought = part.thought === true;

        if (text !== undefined && (text || signature)) {
          const type = thought ? "thinking" : "text";

          for (const chunk of ensureBlock(type)) yield chunk;
          if (text) {
            yield encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: active!.index,
              delta:
                type === "thinking"
                  ? { type: "thinking_delta", thinking: text }
                  : { type: "text_delta", text },
            });
          }
          if (signature && type === "thinking") {
            yield encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: active!.index,
              delta: { type: "signature_delta", signature },
            });
          }
        }
        const functionCall = isRecord(part.functionCall)
          ? part.functionCall
          : isRecord(part.function_call)
            ? part.function_call
            : null;

        if (functionCall) {
          for (const chunk of closeActive()) yield chunk;
          const wireName = requiredString(
            functionCall.name,
            "functionCall.name",
          );
          const id =
            textValue(functionCall.id) ??
            `toolu_${randomUUID().replaceAll("-", "")}`;
          const index = nextIndex++;
          const args = isRecord(functionCall.args) ? functionCall.args : {};

          sawTool = true;
          yield encodeSseEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id,
              name: options.toolNames.get(wireName) ?? wireName,
              input: {},
              ...(signature ? { signature } : {}),
            },
          });
          yield encodeSseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(args),
            },
          });
          yield encodeSseEvent("content_block_stop", {
            type: "content_block_stop",
            index,
          });
        }
      }
      if (candidate && candidate.finishReason !== undefined) {
        terminalReason = candidate.finishReason;
      }
    }
    if (!started)
      throw new ProviderProtocolError("Google returned an empty stream");
    for (const chunk of finish()) yield chunk;
  } catch (error) {
    if (!started) throw error;
    if (!finished) {
      yield encodeSseEvent("error", {
        type: "error",
        error: {
          type: "api_error",
          message: PUBLIC_STREAM_ERROR_MESSAGE,
        },
      });
    }
  }
}

export function antigravitySseToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  options: Pick<AntigravityResponseOptions, "publicModel" | "toolNames">,
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const frames = antigravityFrames(upstream, options, cancellation.signal);

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

export async function transformAntigravityResponse(
  response: Response,
  options: AntigravityResponseOptions,
): Promise<Response> {
  if (!response.ok) return response;
  if (!response.body)
    throw new ProviderProtocolError("Google returned an empty response");
  const anthropicStream = antigravitySseToAnthropicStream(
    response.body,
    options,
  );

  if (options.requestStream) {
    return new Response(anthropicStream, {
      status: response.status,
      headers: mergeHeadersForPublicResponse(
        response,
        "text/event-stream; charset=utf-8",
      ),
    });
  }
  const payload: AnthropicMessageResponse = await aggregateAnthropicSse(
    anthropicStream,
    options.publicModel,
  );

  return new Response(JSON.stringify(payload), {
    status: response.status,
    headers: mergeHeadersForPublicResponse(
      response,
      "application/json; charset=utf-8",
    ),
  });
}

import type {
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicUsage,
} from "../wire/anthropic";

import { randomUUID } from "node:crypto";

import {
  mergeHeadersForPublicResponse,
  readBoundedJson,
} from "../providers/shared";
import { encodeSseEvent, parseSseStream } from "../wire/sse";

export interface ResponsesTranslationOptions {
  publicModel: string;
  requestStream: boolean;
  /** The subscription adapters always request SSE, even when headers omit it. */
  upstreamIsSse?: boolean;
  /**
   * Optional fail-closed visible-output budget for a subscription transport
   * that cannot send max_output_tokens upstream. One UTF-8 byte consumes one
   * unit, deliberately more conservative than model-specific token estimates.
   */
  conservativeOutputByteLimit?: number;
  /** Conservative input usage reported when local cancellation precedes usage. */
  conservativeBilledInputTokens?: number;
  /** Conservative usage reported when a local cutoff cancels an unbounded upstream. */
  conservativeBilledOutputTokens?: number;
}

type StopReason = AnthropicMessageResponse["stop_reason"];

const PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE = "Upstream provider request failed";

export async function transformResponsesResponse(
  response: Response,
  options: ResponsesTranslationOptions,
): Promise<Response> {
  if (!response.ok) return response;
  if (options.requestStream) {
    if (!response.body)
      throw new Error("Responses provider returned an empty stream");

    return new Response(responsesSseToAnthropicStream(response.body, options), {
      status: response.status,
      headers: mergeHeadersForPublicResponse(
        response,
        "text/event-stream; charset=utf-8",
      ),
    });
  }
  if (
    options.upstreamIsSse ||
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  ) {
    if (!response.body)
      throw new Error("Responses provider returned an empty stream");
    const payload = await aggregateAnthropicSse(
      responsesSseToAnthropicStream(response.body, options),
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
  const payload = await readBoundedJson(response, 8 * 1024 * 1024);

  return new Response(
    JSON.stringify(aggregateResponsesToAnthropic(payload, options)),
    {
      status: response.status,
      headers: mergeHeadersForPublicResponse(
        response,
        "application/json; charset=utf-8",
      ),
    },
  );
}

export function aggregateResponsesToAnthropic(
  payload: unknown,
  options: Pick<
    ResponsesTranslationOptions,
    | "publicModel"
    | "conservativeBilledInputTokens"
    | "conservativeBilledOutputTokens"
  >,
): AnthropicMessageResponse {
  const root = asRecord(payload);

  if (!root) throw new TypeError("Responses payload must be an object");
  const response = asRecord(root.response) ?? root;
  const output = Array.isArray(response.output) ? response.output : [];
  const content: AnthropicContentBlock[] = [];
  let hasTool = false;

  for (const rawItem of output) {
    const item = asRecord(rawItem);

    if (!item) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = asRecord(rawPart);

        if (!part) continue;
        if (
          (part.type === "output_text" || part.type === "text") &&
          typeof part.text === "string"
        ) {
          content.push({ type: "text", text: part.text });
        } else if (
          part.type === "refusal" &&
          typeof part.refusal === "string"
        ) {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "reasoning") {
      const thinking = reasoningText(item);

      if (thinking) content.push({ type: "thinking", thinking, signature: "" });
    } else if (item.type === "function_call") {
      hasTool = true;
      content.push({
        type: "tool_use",
        id:
          stringValue(item.call_id) ??
          stringValue(item.id) ??
          `toolu_${randomUUID().replace(/-/g, "")}`,
        name: stringValue(item.name) ?? "unknown_tool",
        input: parseArguments(item.arguments),
      });
    }
  }

  const usageRecord = asRecord(response.usage);
  const usage = usageRecord
    ? mapUsageWithConservativeFallback(usageRecord, options)
    : conservativeUsage(options);
  const status = stringValue(response.status);

  return {
    id: stringValue(response.id) ?? `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: options.publicModel,
    content,
    stop_reason: hasTool
      ? "tool_use"
      : stopReason(status, asRecord(response.incomplete_details)),
    stop_sequence: null,
    usage,
  };
}

export function responsesSseToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  options: Pick<
    ResponsesTranslationOptions,
    | "publicModel"
    | "conservativeOutputByteLimit"
    | "conservativeBilledInputTokens"
    | "conservativeBilledOutputTokens"
  >,
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const chunks = responsesSseToAnthropicChunks(
    upstream,
    options,
    cancellation.signal,
  );

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();

        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancellation.abort(reason);
      await chunks.return(undefined);
    },
  });
}

export async function* responsesSseToAnthropicChunks(
  upstream: ReadableStream<Uint8Array>,
  options: Pick<
    ResponsesTranslationOptions,
    | "publicModel"
    | "conservativeOutputByteLimit"
    | "conservativeBilledInputTokens"
    | "conservativeBilledOutputTokens"
  >,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let started = false;
  let finished = false;
  let terminalEventSeen = false;
  let messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  let responseStatus: string | undefined;
  let incompleteDetails: Record<string, unknown> | null = null;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let usageSeen = false;
  let sawTool = false;
  let forcedStopReason: StopReason = null;
  let outputBytes = 0;
  let nextBlockIndex = 0;
  const blocks = new Map<
    string,
    { index: number; type: "text" | "thinking" | "tool_use"; open: boolean }
  >();

  const startMessage = (): Uint8Array[] => {
    if (started) return [];
    started = true;

    return [
      encodeSseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: options.publicModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  };

  const ensureBlock = (
    key: string,
    type: "text" | "thinking" | "tool_use",
    initial: Record<string, unknown>,
  ): Uint8Array[] => {
    const existing = blocks.get(key);

    if (existing) return [];
    const block = { index: nextBlockIndex++, type, open: true } as const;

    blocks.set(key, { ...block });

    return [
      ...startMessage(),
      encodeSseEvent("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: initial,
      }),
    ];
  };

  const stopBlock = (key: string): Uint8Array[] => {
    const block = blocks.get(key);

    if (!block?.open) return [];
    block.open = false;

    return [
      encodeSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: block.index,
      }),
    ];
  };

  const finish = (): Uint8Array[] => {
    if (finished) return [];
    finished = true;
    if (!usageSeen) usage = conservativeUsage(options);
    const chunks = startMessage();

    for (const [key] of blocks) chunks.push(...stopBlock(key));
    chunks.push(
      encodeSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason:
            forcedStopReason ??
            (sawTool
              ? "tool_use"
              : stopReason(responseStatus, incompleteDetails)),
          stop_sequence: null,
        },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          ...(usage.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
            : {}),
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
        },
      }),
      encodeSseEvent("message_stop", { type: "message_stop" }),
    );

    return chunks;
  };

  const takeOutputBudget = (
    value: string,
    fixedOverhead = 0,
  ): { value: string; exhausted: boolean } => {
    const limit = options.conservativeOutputByteLimit;

    if (limit === undefined) return { value, exhausted: false };
    const remaining = Math.max(0, limit - outputBytes - fixedOverhead);
    const limited = truncateUtf8(value, remaining);

    outputBytes += fixedOverhead + Buffer.byteLength(limited, "utf8");

    return {
      value: limited,
      exhausted: limited !== value || outputBytes >= limit,
    };
  };

  const maxTokensChunks = (): Uint8Array[] => {
    forcedStopReason = "max_tokens";
    usage.input_tokens = Math.max(
      usage.input_tokens,
      options.conservativeBilledInputTokens ?? 0,
    );
    usage.output_tokens = Math.max(
      usage.output_tokens,
      options.conservativeBilledOutputTokens ??
        options.conservativeOutputByteLimit ??
        0,
    );

    return finish();
  };

  const providerErrorChunks = (): Uint8Array[] => {
    if (!started) throw new Error(PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE);
    finished = true;

    return [
      encodeSseEvent("error", {
        type: "error",
        error: {
          type: "api_error",
          message: PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE,
        },
      }),
    ];
  };

  for await (const frame of parseSseStream(upstream, signal)) {
    if (frame.event === "error" || frame.event === "response.failed") {
      for (const chunk of providerErrorChunks()) yield chunk;

      return;
    }
    if (frame.data === "[DONE]") {
      terminalEventSeen = true;
      for (const chunk of finish()) yield chunk;
      continue;
    }
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventType = stringValue(event.type) ?? frame.event;
    const response = asRecord(event.response);

    if (response) {
      messageId = stringValue(response.id) ?? messageId;
      responseStatus = stringValue(response.status) ?? responseStatus;
      incompleteDetails =
        asRecord(response.incomplete_details) ?? incompleteDetails;
      if (asRecord(response.usage)) {
        usage = mapUsageWithConservativeFallback(
          asRecord(response.usage)!,
          options,
        );
        usageSeen = true;
      }
    }

    if (eventType === "error" || eventType === "response.failed") {
      for (const chunk of providerErrorChunks()) yield chunk;

      return;
    }
    if (
      eventType === "response.created" ||
      eventType === "response.in_progress"
    ) {
      for (const chunk of startMessage()) yield chunk;
      continue;
    }

    const item = asRecord(event.item);
    const outputIndex = numberValue(event.output_index) ?? 0;
    const itemId =
      stringValue(event.item_id) ??
      stringValue(item?.id) ??
      String(outputIndex);

    if (
      eventType === "response.output_item.added" &&
      item?.type === "function_call"
    ) {
      sawTool = true;
      const key = `tool:${itemId}`;
      const callId =
        stringValue(item.call_id) ??
        stringValue(item.id) ??
        `toolu_${randomUUID().replace(/-/g, "")}`;
      const name = stringValue(item.name) ?? "unknown_tool";
      const identityBudget = takeOutputBudget(`${callId}${name}`, 8);

      if (identityBudget.exhausted) {
        for (const chunk of maxTokensChunks()) yield chunk;

        return;
      }

      for (const chunk of ensureBlock(key, "tool_use", {
        type: "tool_use",
        id: callId,
        name,
        input: {},
      }))
        yield chunk;
      continue;
    }

    if (eventType === "response.output_text.delta") {
      const key = `text:${itemId}:${numberValue(event.content_index) ?? 0}`;

      for (const chunk of ensureBlock(key, "text", { type: "text", text: "" }))
        yield chunk;
      const block = blocks.get(key);
      const budget = takeOutputBudget(stringValue(event.delta) ?? "");
      const delta = budget.value;

      if (block && delta) {
        yield encodeSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text: delta },
        });
      }
      if (budget.exhausted) {
        for (const chunk of maxTokensChunks()) yield chunk;

        return;
      }
      continue;
    }

    if (
      eventType === "response.reasoning_summary_text.delta" ||
      eventType === "response.reasoning_text.delta"
    ) {
      const key = `thinking:${itemId}`;

      for (const chunk of ensureBlock(key, "thinking", {
        type: "thinking",
        thinking: "",
        signature: "",
      }))
        yield chunk;
      const block = blocks.get(key);
      const budget = takeOutputBudget(stringValue(event.delta) ?? "");
      const delta = budget.value;

      if (block && delta) {
        yield encodeSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "thinking_delta", thinking: delta },
        });
      }
      if (budget.exhausted) {
        for (const chunk of maxTokensChunks()) yield chunk;

        return;
      }
      continue;
    }

    if (eventType === "response.function_call_arguments.delta") {
      sawTool = true;
      const key = `tool:${itemId}`;

      for (const chunk of ensureBlock(key, "tool_use", {
        type: "tool_use",
        id:
          stringValue(event.call_id) ??
          `toolu_${randomUUID().replace(/-/g, "")}`,
        name: stringValue(event.name) ?? "unknown_tool",
        input: {},
      }))
        yield chunk;
      const block = blocks.get(key);
      const budget = takeOutputBudget(stringValue(event.delta) ?? "");
      const partialJson = budget.value;

      if (block && partialJson) {
        yield encodeSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: partialJson },
        });
      }
      if (budget.exhausted) {
        for (const chunk of maxTokensChunks()) yield chunk;

        return;
      }
      continue;
    }

    if (eventType === "response.output_item.done") {
      const itemType = stringValue(item?.type);

      if (itemType === "function_call") {
        for (const chunk of stopBlock(`tool:${itemId}`)) yield chunk;
      }
      continue;
    }

    if (eventType === "response.content_part.done") {
      for (const chunk of stopBlock(
        `text:${itemId}:${numberValue(event.content_index) ?? 0}`,
      ))
        yield chunk;
      continue;
    }

    if (
      eventType === "response.completed" ||
      eventType === "response.done" ||
      eventType === "response.incomplete"
    ) {
      terminalEventSeen = true;
      responseStatus =
        responseStatus ??
        (eventType === "response.incomplete" ? "incomplete" : "completed");
      for (const chunk of finish()) yield chunk;
    }
  }
  if (!finished && !terminalEventSeen) {
    const message = "Upstream Responses stream ended before completion";

    if (!started) throw new Error(message);
    yield encodeSseEvent("error", {
      type: "error",
      error: { type: "api_error", message },
    });
    finished = true;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let used = 0;

  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");

    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }

  return output;
}

async function aggregateAnthropicSse(
  stream: ReadableStream<Uint8Array>,
  publicModel: string,
): Promise<AnthropicMessageResponse> {
  let id = `msg_${randomUUID().replace(/-/g, "")}`;
  let model = publicModel;
  let stopReasonValue: StopReason = null;
  let sawMessageStop = false;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  const blocks = new Map<
    number,
    { block: AnthropicContentBlock; partialJson: string }
  >();

  for await (const frame of parseSseStream(stream)) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const event = asRecord(parsed);

    if (!event) continue;
    const type = stringValue(event.type) ?? frame.event;

    if (type === "error") {
      throw new Error(PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE);
    }
    if (type === "message_stop") {
      sawMessageStop = true;
      continue;
    }

    if (type === "message_start") {
      const message = asRecord(event.message);

      id = stringValue(message?.id) ?? id;
      model = stringValue(message?.model) ?? model;
      usage = { ...usage, ...mapUsageLikeAnthropic(asRecord(message?.usage)) };
      continue;
    }
    const index = numberValue(event.index);

    if (type === "content_block_start" && index !== undefined) {
      const blockRecord = asRecord(event.content_block);

      if (!blockRecord || typeof blockRecord.type !== "string") continue;
      blocks.set(index, {
        block: { ...blockRecord } as AnthropicContentBlock,
        partialJson: "",
      });
      continue;
    }
    if (type === "content_block_delta" && index !== undefined) {
      const state = blocks.get(index);
      const delta = asRecord(event.delta);

      if (!state || !delta) continue;
      if (state.block.type === "text" && typeof delta.text === "string") {
        state.block.text = `${typeof state.block.text === "string" ? state.block.text : ""}${delta.text}`;
      } else if (
        state.block.type === "thinking" &&
        typeof delta.thinking === "string"
      ) {
        state.block.thinking = `${typeof state.block.thinking === "string" ? state.block.thinking : ""}${delta.thinking}`;
      } else if (
        state.block.type === "tool_use" &&
        typeof delta.partial_json === "string"
      ) {
        state.partialJson += delta.partial_json;
      }
      continue;
    }
    if (type === "content_block_stop" && index !== undefined) {
      const state = blocks.get(index);

      if (state?.block.type === "tool_use" && state.partialJson) {
        state.block.input = parseArguments(state.partialJson);
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = asRecord(event.delta);
      const reason = stringValue(delta?.stop_reason);

      if (
        reason === "end_turn" ||
        reason === "max_tokens" ||
        reason === "stop_sequence" ||
        reason === "tool_use" ||
        reason === "refusal"
      ) {
        stopReasonValue = reason;
      }
      usage = { ...usage, ...mapUsageLikeAnthropic(asRecord(event.usage)) };
    }
  }

  if (!sawMessageStop) {
    throw new Error("Upstream Responses stream ended before completion");
  }

  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, state]) => state.block),
    stop_reason: stopReasonValue ?? "end_turn",
    stop_sequence: null,
    usage,
  };
}

function mapUsageLikeAnthropic(
  value: Record<string, unknown> | null,
): Partial<AnthropicUsage> {
  if (!value) return {};
  const result: Partial<AnthropicUsage> = {};
  const input = finiteOptional(value.input_tokens);
  const output = finiteOptional(value.output_tokens);
  const cacheRead = finiteOptional(value.cache_read_input_tokens);
  const cacheWrite = finiteOptional(value.cache_creation_input_tokens);

  if (input !== undefined) result.input_tokens = input;
  if (output !== undefined) result.output_tokens = output;
  if (cacheRead !== undefined) result.cache_read_input_tokens = cacheRead;
  if (cacheWrite !== undefined) result.cache_creation_input_tokens = cacheWrite;

  return result;
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];

  return summary
    .map((part) => {
      const record = asRecord(part);

      return stringValue(record?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

function mapUsage(value: Record<string, unknown> | null): AnthropicUsage {
  const input = finiteOrZero(value?.input_tokens);
  const output = finiteOrZero(value?.output_tokens);
  const inputDetails = asRecord(value?.input_tokens_details);
  const cached = finiteOptional(inputDetails?.cached_tokens);
  const cacheWrite = finiteOptional(inputDetails?.cache_write_tokens);

  return {
    input_tokens: Math.max(0, input - (cached ?? 0)),
    output_tokens: output,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    ...(cacheWrite !== undefined
      ? { cache_creation_input_tokens: cacheWrite }
      : {}),
  };
}

const mapUsageWithConservativeFallback = (
  value: Record<string, unknown>,
  options: Pick<
    ResponsesTranslationOptions,
    "conservativeBilledInputTokens" | "conservativeBilledOutputTokens"
  >,
): AnthropicUsage => {
  const mapped = mapUsage(value);
  const inputDetails = asRecord(value.input_tokens_details);
  const cached = finiteOptional(inputDetails?.cached_tokens) ?? 0;

  return {
    ...mapped,
    input_tokens:
      finiteOptional(value.input_tokens) === undefined
        ? Math.max(0, options.conservativeBilledInputTokens ?? 0)
        : mapped.input_tokens,
    output_tokens:
      finiteOptional(value.output_tokens) === undefined
        ? Math.max(0, options.conservativeBilledOutputTokens ?? 0)
        : mapped.output_tokens,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  };
};

const conservativeUsage = (
  options: Pick<
    ResponsesTranslationOptions,
    "conservativeBilledInputTokens" | "conservativeBilledOutputTokens"
  >,
): AnthropicUsage => ({
  input_tokens: Math.max(0, options.conservativeBilledInputTokens ?? 0),
  output_tokens: Math.max(0, options.conservativeBilledOutputTokens ?? 0),
});

function stopReason(
  status: string | undefined,
  incomplete: Record<string, unknown> | null,
): StopReason {
  if (status === "incomplete") {
    const reason = stringValue(incomplete?.reason);

    if (reason === "max_output_tokens" || reason === "max_tokens")
      return "max_tokens";
    if (reason === "content_filter") return "refusal";
  }
  if (status === "failed" || status === "cancelled") return "refusal";

  return "end_turn";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function finiteOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

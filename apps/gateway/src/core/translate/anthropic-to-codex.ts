import type { CodexToolIdentity } from "./codex-to-anthropic";

import { randomUUID } from "node:crypto";

import { encodeSseEvent, parseSseStream } from "../wire/sse";

const PUBLIC_STREAM_ERROR = {
  type: "response.failed",
  response: {
    id: "resp_gateway_error",
    error: {
      type: "server_error",
      code: "upstream_failure",
      message: "Upstream provider request failed",
      param: null,
    },
  },
} as const;

type ActiveBlock =
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking" }
  | {
      kind: "tool";
      id: string;
      name: string;
      partialJson: string;
    };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteUsage = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const isPlaintextCollaborationTool = (tool: CodexToolIdentity): boolean =>
  tool.kind === "function" &&
  tool.namespace === "collaboration" &&
  (tool.name === "spawn_agent" ||
    tool.name === "send_message" ||
    tool.name === "followup_task");

const outputItem = (
  block: ActiveBlock,
  identity: CodexToolIdentity | undefined,
): Record<string, unknown> | null => {
  if (block.kind === "thinking") return null;
  if (block.kind === "text") {
    return {
      type: "message",
      id: block.id,
      role: "assistant",
      content: [{ type: "output_text", text: block.text }],
    };
  }
  const parsed = block.partialJson ? JSON.parse(block.partialJson) : {};
  const tool = identity ?? { kind: "function" as const, name: block.name };

  if (tool.kind === "custom") {
    const input = record(parsed)?.input;

    return {
      type: "custom_tool_call",
      id: block.id,
      call_id: block.id,
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      input: typeof input === "string" ? input : JSON.stringify(parsed),
      status: "completed",
    };
  }

  return {
    type: "function_call",
    id: block.id,
    call_id: block.id,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(parsed),
    ...(isPlaintextCollaborationTool(tool)
      ? { encrypted_function_args: [] }
      : {}),
  };
};

async function* translateFrames(
  upstream: ReadableStream<Uint8Array>,
  publicModel: string,
  toolIdentities: ReadonlyMap<string, CodexToolIdentity>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let stopReason: string | null = null;
  const blocks = new Map<number, ActiveBlock>();
  const ensureCreated = () => {
    if (created) return [];
    created = true;

    return [
      encodeSseEvent("response.created", {
        type: "response.created",
        response: { id: responseId, model: publicModel },
      }),
    ];
  };

  try {
    for await (const frame of parseSseStream(upstream, signal)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const event = record(JSON.parse(frame.data));

      if (!event) throw new TypeError("Anthropic SSE event must be an object");
      if (event.type === "error" || frame.event === "error") {
        for (const chunk of ensureCreated()) yield chunk;
        yield encodeSseEvent("response.failed", {
          ...PUBLIC_STREAM_ERROR,
          response: { ...PUBLIC_STREAM_ERROR.response, id: responseId },
        });

        return;
      }
      if (event.type === "message_start") {
        const message = record(event.message);

        if (typeof message?.id === "string") responseId = message.id;
        const usage = record(message?.usage);

        inputTokens = finiteUsage(usage?.input_tokens);
        cachedTokens =
          finiteUsage(usage?.cache_read_input_tokens) +
          finiteUsage(usage?.cache_creation_input_tokens);
        for (const chunk of ensureCreated()) yield chunk;
        continue;
      }
      if (event.type === "content_block_start") {
        const index = finiteUsage(event.index);
        const content = record(event.content_block);

        if (content?.type === "text") {
          const block = {
            kind: "text",
            id: `msg_${responseId}_${index}`,
            text: typeof content.text === "string" ? content.text : "",
          } as const;

          blocks.set(index, { ...block });
          yield encodeSseEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: index,
            item: {
              type: "message",
              id: block.id,
              role: "assistant",
              content: [],
            },
          });
        } else if (content?.type === "tool_use") {
          blocks.set(index, {
            kind: "tool",
            id:
              typeof content.id === "string"
                ? content.id
                : `call_${randomUUID().replaceAll("-", "")}`,
            name: typeof content.name === "string" ? content.name : "unknown",
            partialJson: "",
          });
        } else {
          blocks.set(index, { kind: "thinking" });
        }
        for (const chunk of ensureCreated()) yield chunk;
        continue;
      }
      if (event.type === "content_block_delta") {
        const index = finiteUsage(event.index);
        const block = blocks.get(index);
        const delta = record(event.delta);

        if (block?.kind === "text" && typeof delta?.text === "string") {
          block.text += delta.text;
          yield encodeSseEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: block.id,
            output_index: index,
            content_index: 0,
            delta: delta.text,
          });
        } else if (
          block?.kind === "tool" &&
          typeof delta?.partial_json === "string"
        ) {
          block.partialJson += delta.partial_json;
        }
        continue;
      }
      if (event.type === "content_block_stop") {
        const index = finiteUsage(event.index);
        const block = blocks.get(index);

        if (!block) continue;
        const item = outputItem(
          block,
          block.kind === "tool" ? toolIdentities.get(block.name) : undefined,
        );

        if (item) {
          yield encodeSseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: index,
            item,
          });
        }
        continue;
      }
      if (event.type === "message_delta") {
        const delta = record(event.delta);
        const usage = record(event.usage);

        if (typeof delta?.stop_reason === "string")
          stopReason = delta.stop_reason;
        outputTokens = Math.max(
          outputTokens,
          finiteUsage(usage?.output_tokens),
        );
        continue;
      }
      if (event.type === "message_stop") {
        for (const chunk of ensureCreated()) yield chunk;
        yield encodeSseEvent("response.completed", {
          type: "response.completed",
          response: {
            id: responseId,
            model: publicModel,
            status: "completed",
            output: [],
            end_turn: stopReason === "end_turn",
            usage: {
              input_tokens: inputTokens + cachedTokens,
              input_tokens_details: { cached_tokens: cachedTokens },
              output_tokens: outputTokens,
              output_tokens_details: null,
              total_tokens: inputTokens + cachedTokens + outputTokens,
            },
          },
        });

        return;
      }
    }
  } catch {
    for (const chunk of ensureCreated()) yield chunk;
    yield encodeSseEvent("response.failed", {
      ...PUBLIC_STREAM_ERROR,
      response: { ...PUBLIC_STREAM_ERROR.response, id: responseId },
    });
  }
}

export function anthropicSseToCodexResponses(
  upstream: ReadableStream<Uint8Array>,
  options: {
    publicModel: string;
    toolIdentities: ReadonlyMap<string, CodexToolIdentity>;
  },
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const frames = translateFrames(
    upstream,
    options.publicModel,
    options.toolIdentities,
    cancellation.signal,
  );

  return new ReadableStream({
    async pull(controller) {
      const next = await frames.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      cancellation.abort(reason);
      await frames.return(undefined);
    },
  });
}

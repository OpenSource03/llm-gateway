import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { ProviderIdentity } from "./types";

import { claudeCodeWireToolName } from "../claude-code-tool-name";
import { encodeSseEvent, parseSseStream } from "../wire/sse";

import { promoteAnthropicSubscriptionCacheRetention } from "./anthropic-cache-policy";
import { signClaudeCodeRequestBody } from "./claude-code-cch";
import {
  mergeHeadersForPublicResponse,
  normalizeSessionId,
  ProviderProtocolError,
  readBoundedJson,
  sha256Hex,
  stableUuid,
} from "./shared";

export const CLAUDE_CODE = {
  version: "2.1.260",
  promptVariant: "f3e",
  userAgent: "claude-cli/2.1.260 (external, cli)",
  sdkPackageVersion: "0.112.1",
  runtimeVersion: "v26.3.0",
} as const;

const BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
  "fallback-credit-2026-06-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
] as const;

const PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE = "Upstream provider request failed";

const BODY_ORDER = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "temperature",
  "top_p",
  "stop_sequences",
  "thinking",
  "context_management",
  "output_config",
  "diagnostics",
  "stream",
] as const;

export interface ClaudeWireRewrite {
  body: string;
  sessionId: string;
  headers: Headers;
  toolNames: Map<string, string>;
}

export function rewriteClaudeCodeRequest(input: {
  request: AnthropicMessagesRequest;
  upstreamModel: string;
  identity: ProviderIdentity;
  accessToken: string;
  sessionId?: string;
  requestId: string;
}): ClaudeWireRewrite {
  return rewriteClaudeCodeWire(input, false);
}

/** Build the Claude Code-authenticated body accepted by count_tokens. */
export function rewriteClaudeCodeCountTokensRequest(input: {
  request: AnthropicMessagesRequest;
  upstreamModel: string;
  identity: ProviderIdentity;
  accessToken: string;
  sessionId?: string;
  requestId: string;
}): ClaudeWireRewrite {
  return rewriteClaudeCodeWire(input, true);
}

function rewriteClaudeCodeWire(
  input: {
    request: AnthropicMessagesRequest;
    upstreamModel: string;
    identity: ProviderIdentity;
    accessToken: string;
    sessionId?: string;
    requestId: string;
  },
  countTokens: boolean,
): ClaudeWireRewrite {
  const source = structuredClone(input.request);
  const request = allowedClaudeRequest(source, input.upstreamModel);

  promoteAnthropicSubscriptionCacheRetention(request);

  if (countTokens) {
    // These fields belong to message generation, while the public token-count
    // contract intentionally accepts requests without them.
    delete (request as Partial<AnthropicMessagesRequest>).max_tokens;
    delete request.stream;
    delete request.temperature;
    delete request.top_p;
    delete request.stop_sequences;
  }
  const sessionId = normalizeSessionId(input.sessionId, input.requestId);
  const promptId = stableUuid(`claude-prompt:${sessionId}`);
  const toolNames = prefixClaudeToolNames(request);
  const system = normalizeSystem(request.system).filter(
    (block) => !block.text.startsWith("x-anthropic-billing-header:"),
  );
  const hasIdentity = system.some((block) =>
    block.text.includes("You are Claude Code"),
  );
  const billing = {
    type: "text" as const,
    text:
      `x-anthropic-billing-header: cc_version=${CLAUDE_CODE.version}.${CLAUDE_CODE.promptVariant}; ` +
      "cc_entrypoint=cli; cch=00000;" +
      ` cc_prompt_id=${promptId};`,
  };

  request.system = [
    billing,
    ...(!hasIdentity
      ? [
          {
            type: "text" as const,
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ]
      : []),
    ...system,
  ];
  const accountUuid = input.identity.externalAccountId;

  request.metadata = {
    user_id: JSON.stringify({
      device_id: sha256Hex(`device:${accountUuid}`),
      account_uuid: accountUuid,
      session_id: sessionId,
    }),
  };
  request.diagnostics = {
    previous_message_id: null,
  };

  const ordered: Record<string, unknown> = {};

  for (const key of BODY_ORDER)
    if (Object.hasOwn(request, key)) ordered[key] = request[key];
  const body = signClaudeCodeRequestBody(JSON.stringify(ordered));

  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${input.accessToken}`,
    "content-type": "application/json",
    "user-agent": CLAUDE_CODE.userAgent,
    "anthropic-beta": selectBetas(request),
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    "x-client-request-id": input.requestId,
    "x-claude-code-session-id": sessionId,
    "x-stainless-arch": stainlessArch(),
    "x-stainless-lang": "js",
    "x-stainless-os": stainlessOs(),
    "x-stainless-package-version": CLAUDE_CODE.sdkPackageVersion,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": CLAUDE_CODE.runtimeVersion,
    "x-stainless-timeout": "600",
  });

  return { body, headers, sessionId, toolNames };
}

/**
 * Reconstruct, rather than clone-and-forward, the provider request. The public
 * gateway deliberately exposes the portable Anthropic Messages subset only;
 * pooled OAuth credentials must never become a deputy for unreviewed provider
 * resource/file/MCP features hidden in arbitrary extension keys.
 */
function allowedClaudeRequest(
  source: AnthropicMessagesRequest,
  upstreamModel: string,
): AnthropicMessagesRequest {
  const request: AnthropicMessagesRequest = {
    model: upstreamModel,
    messages: source.messages,
    max_tokens: source.max_tokens,
  };

  if (source.system !== undefined) request.system = source.system;
  if (source.tools !== undefined) request.tools = source.tools;
  if (source.tool_choice !== undefined && source.tool_choice.type !== "auto")
    request.tool_choice = source.tool_choice;
  if (source.temperature !== undefined)
    request.temperature = source.temperature;
  if (source.top_p !== undefined) request.top_p = source.top_p;
  if (source.stop_sequences !== undefined)
    request.stop_sequences = source.stop_sequences;
  if (source.thinking !== undefined) request.thinking = source.thinking;
  if (source.output_config?.effort !== undefined) {
    request.output_config = { effort: source.output_config.effort };
  }
  if (source.context_management !== undefined) {
    request.context_management = source.context_management;
  }
  if (source.stream !== undefined) request.stream = source.stream;

  return request;
}

function normalizeSystem(
  system: AnthropicMessagesRequest["system"],
): Array<{ type: "text"; text: string }> {
  if (typeof system === "string")
    return system ? [{ type: "text", text: system }] : [];
  if (!Array.isArray(system)) return [];

  return system
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => ({ ...block, type: "text", text: block.text }));
}

function prefixClaudeToolNames(
  request: AnthropicMessagesRequest,
): Map<string, string> {
  const names = new Map<string, string>();
  const remember = (original: string): string => {
    const prefixed = claudeCodeWireToolName(original);
    const existing = names.get(prefixed);

    if (existing !== undefined && existing !== original) {
      throw new ProviderProtocolError(
        `Claude tool names '${existing}' and '${original}' collide after namespacing`,
      );
    }
    names.set(prefixed, original);

    return prefixed;
  };

  for (const tool of request.tools ?? []) {
    const original = tool.name;

    tool.name = remember(original);
  }
  if (request.tool_choice?.type === "tool") {
    const original = request.tool_choice.name;

    request.tool_choice.name = remember(original);
  }
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        const original = block.name;

        block.name = remember(original);
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (
            nested.type !== "tool_reference" ||
            typeof nested.tool_name !== "string"
          ) {
            continue;
          }
          const original = nested.tool_name;

          nested.tool_name = remember(original);
        }
      }
    }
  }

  return names;
}

const selectBetas = (request: AnthropicMessagesRequest): string => {
  const betas: string[] = [...BASE_BETAS];

  if (
    request.context_management?.edits.some(
      (edit) => edit.type === "compact_20260112",
    )
  ) {
    betas.push("compact-2026-01-12");
  }

  return betas.join(",");
};

function stainlessOs(): string {
  if (process.platform === "darwin") return "MacOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  if (process.platform === "freebsd") return "FreeBSD";

  return "Unknown";
}

function stainlessArch(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "x32";

  return process.arch;
}

export async function transformClaudeResponse(
  response: Response,
  stream: boolean,
  toolNames: ReadonlyMap<string, string>,
): Promise<Response> {
  if (!response.ok) return response;
  if (!stream) {
    const value = await readBoundedJson(response, 8 * 1024 * 1024);

    rewriteToolNames(value, toolNames);

    return new Response(JSON.stringify(value), {
      status: response.status,
      headers: mergeHeadersForPublicResponse(
        response,
        "application/json; charset=utf-8",
      ),
    });
  }
  if (!response.body) throw new Error("Anthropic returned an empty stream");
  const upstream = response.body;
  const cancellation = new AbortController();
  const frames = transformedClaudeFrames(
    upstream,
    toolNames,
    cancellation.signal,
  );
  const body = new ReadableStream<Uint8Array>({
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

  return new Response(body, {
    status: response.status,
    headers: mergeHeadersForPublicResponse(
      response,
      "text/event-stream; charset=utf-8",
    ),
  });
}

async function* transformedClaudeFrames(
  upstream: ReadableStream<Uint8Array>,
  toolNames: ReadonlyMap<string, string>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const frame of parseSseStream(upstream, signal)) {
    if (frame.event === "error") {
      yield publicProviderErrorFrame();

      return;
    }
    if (frame.data === "[DONE]") {
      yield encodeSseEvent(frame.event ?? "message_stop", frame.data);
      continue;
    }
    let data: unknown = frame.data;

    try {
      data = JSON.parse(frame.data);
    } catch {
      // Unknown forward-compatible data is preserved verbatim.
    }
    if (inferEventName(data) === "error") {
      yield publicProviderErrorFrame();

      return;
    }
    rewriteToolNames(data, toolNames);
    yield encodeSseEvent(frame.event ?? inferEventName(data), data);
  }
}

function publicProviderErrorFrame(): Uint8Array {
  return encodeSseEvent("error", {
    type: "error",
    error: {
      type: "api_error",
      message: PUBLIC_PROVIDER_STREAM_ERROR_MESSAGE,
    },
  });
}

function rewriteToolNames(
  value: unknown,
  toolNames: ReadonlyMap<string, string>,
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const rewriteBlock = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const block = candidate as Record<string, unknown>;

    if (block.type !== "tool_use" || typeof block.name !== "string") return;
    const original = toolNames.get(block.name);

    if (original) block.name = original;
  };

  rewriteBlock(record);
  if (Array.isArray(record.content)) {
    for (const block of record.content) rewriteBlock(block);
  }
  const message =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : null;

  if (Array.isArray(message?.content)) {
    for (const block of message.content) rewriteBlock(block);
  }
  rewriteBlock(record.content_block);
}

function inferEventName(data: unknown): string {
  if (
    data &&
    typeof data === "object" &&
    "type" in data &&
    typeof data.type === "string"
  )
    return data.type;

  return "message";
}

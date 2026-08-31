import type {
  AnthropicContentBlock,
  AnthropicMessagesRequest,
} from "../wire/anthropic";

const oneHour = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const cacheControl = value as Record<string, unknown>;

  return cacheControl.type === "ephemeral"
    ? { ...cacheControl, ttl: "1h" }
    : value;
};

const promote = <T extends object>(value: T): void => {
  const cacheable = value as T & { cache_control?: unknown };

  if (cacheable.cache_control !== undefined) {
    cacheable.cache_control = oneHour(cacheable.cache_control);
  }
};

const promoteContent = (blocks: AnthropicContentBlock[]): void => {
  for (const block of blocks) {
    promote(block);
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      promoteContent(block.content);
    }
  }
};

/**
 * Match first-party Claude Code's one-hour prompt-cache retention on the
 * subscription transport. The caller owns a deep-cloned request; this function
 * mutates only existing cache controls and never creates another breakpoint.
 */
export function promoteAnthropicSubscriptionCacheRetention(
  request: AnthropicMessagesRequest,
): void {
  if (Array.isArray(request.system)) promoteContent(request.system);
  for (const tool of request.tools ?? []) promote(tool);
  for (const message of request.messages) {
    if (Array.isArray(message.content)) promoteContent(message.content);
  }
}

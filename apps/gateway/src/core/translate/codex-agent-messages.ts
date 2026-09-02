import type { CodexResponsesRequest } from "../wire/codex-responses";

const plaintextAgentContent = (
  value: unknown,
): Array<Record<string, unknown>> | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    value.some(
      (block) =>
        !block ||
        typeof block !== "object" ||
        Array.isArray(block) ||
        !("type" in block) ||
        block.type !== "input_text" ||
        !("text" in block) ||
        typeof block.text !== "string",
    )
  ) {
    return null;
  }

  return value as Array<Record<string, unknown>>;
};

/**
 * Lower locally readable V2 inter-agent messages to ordinary Responses user
 * messages. Opaque provider-encrypted messages remain untouched so their
 * originating provider can decrypt them.
 */
export const lowerPlaintextCodexAgentMessages = (
  request: CodexResponsesRequest,
): CodexResponsesRequest => {
  let changed = false;
  const input = request.input.map((item) => {
    if (item.type !== "agent_message") return item;
    const content = plaintextAgentContent(item.content);

    if (!content) return item;
    changed = true;

    return { type: "message", role: "user", content };
  });

  return changed ? { ...request, input } : request;
};

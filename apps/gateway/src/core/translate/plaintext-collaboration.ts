import type { CodexResponsesRequest } from "../wire/codex-responses";

interface ToolIdentity {
  name: string;
  namespace?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identityKey = (name: unknown, namespace: unknown) =>
  `${namespace ?? ""}\u0000${name}`;

export const isCollaborationMessageTool = (
  name: unknown,
  namespace: unknown,
): boolean =>
  (namespace === "collaboration" || namespace === "multi_agent_v1") &&
  (name === "spawn_agent" ||
    name === "send_message" ||
    name === "followup_task");

/**
 * Native delegation schemas request provider encryption, which is not portable
 * to other providers. Use ordinary function aliases with an ordinary plaintext
 * message schema, then restore the original client tool contract on return.
 */
export function preparePlaintextCollaboration(request: CodexResponsesRequest): {
  request: CodexResponsesRequest;
  plaintextTools: ReadonlyMap<string, ToolIdentity>;
} {
  const plaintextTools = new Map<string, ToolIdentity>();
  const byIdentity = new Map<string, string>();
  const usedNames = new Set<string>();
  const rememberNames = (tools: readonly Record<string, unknown>[]) => {
    for (const tool of tools) {
      if (typeof tool.name === "string") usedNames.add(tool.name);
      if (Array.isArray(tool.tools)) rememberNames(tool.tools.filter(record));
    }
  };
  rememberNames(request.tools ?? []);
  for (const item of request.input)
    if (Array.isArray(item.tools)) rememberNames(item.tools.filter(record));
  const lowered: Record<string, unknown>[] = [];
  const lowerTools = (
    tools: readonly Record<string, unknown>[],
    namespace?: string,
  ): Record<string, unknown>[] =>
    tools.flatMap((tool) => {
      if (
        tool.type === "namespace" &&
        typeof tool.name === "string" &&
        Array.isArray(tool.tools)
      ) {
        const nested = lowerTools(tool.tools.filter(record), tool.name);
        return nested.length ? [{ ...tool, tools: nested }] : [];
      }
      if (
        tool.type !== "function" ||
        !isCollaborationMessageTool(tool.name, namespace) ||
        !record(tool.parameters) ||
        !record(tool.parameters.properties)
      )
        return [tool];
      const fields = tool.parameters.properties;
      if (!record(fields.message) || fields.message.type !== "string")
        return [tool];
      const key = identityKey(tool.name, namespace);
      if (!byIdentity.has(key)) {
        const base = `llmgw_delegate_${String(tool.name)}`;
        let alias = base;
        for (let suffix = 1; usedNames.has(alias); suffix++)
          alias = `${base}_${suffix}`;
        usedNames.add(alias);
        byIdentity.set(key, alias);
        plaintextTools.set(alias, { name: String(tool.name), namespace });
        const message = { ...fields.message };
        delete message.encrypted;
        lowered.push({
          ...tool,
          name: alias,
          parameters: {
            ...tool.parameters,
            properties: { ...fields, message },
          },
        });
      }
      return [];
    });
  const tools = lowerTools(request.tools ?? []);
  const input = request.input.map((item) =>
    Array.isArray(item.tools)
      ? { ...item, tools: lowerTools(item.tools.filter(record)) }
      : item,
  );
  if (plaintextTools.size === 0) return { request, plaintextTools };
  return {
    plaintextTools,
    request: {
      ...request,
      tools: [...tools, ...lowered],
      input: input.map((item) => {
        // Only calls already declared plaintext came from this mapping. Keep
        // historical encrypted native calls unchanged for their own provider.
        if (
          item.type !== "function_call" ||
          !Array.isArray(item.encrypted_function_args) ||
          item.encrypted_function_args.length !== 0
        )
          return item;
        const alias = byIdentity.get(identityKey(item.name, item.namespace));
        if (!alias) return item;
        const loweredItem: Record<string, unknown> = { ...item, name: alias };
        delete loweredItem.namespace;
        delete loweredItem.encrypted_function_args;
        return loweredItem;
      }),
    },
  };
}

export function restorePlaintextCollaborationItem(
  item: Record<string, unknown>,
  plaintextTools: ReadonlyMap<string, ToolIdentity>,
): Record<string, unknown> {
  if (item.type !== "function_call" || typeof item.name !== "string")
    return item;
  const original = plaintextTools.get(item.name);
  if (!original) return item;
  if (
    item.encrypted_function_args != null &&
    (!Array.isArray(item.encrypted_function_args) ||
      item.encrypted_function_args.length > 0)
  ) {
    throw new TypeError("Plaintext delegation returned encrypted arguments");
  }
  return { ...item, ...original, encrypted_function_args: [] };
}

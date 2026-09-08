import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
} from "../wire/anthropic";
import type { CodexResponsesRequest } from "../wire/codex-responses";

import { claudeCodeMcpToolName } from "../claude-code-tool-name";

import { normalizeObjectRootToolInputSchema } from "./object-root-tool-schema";

export interface CodexToolIdentity {
  kind: "function" | "custom";
  name: string;
  namespace?: string;
}

export interface CodexToAnthropicResult {
  request: AnthropicMessagesRequest;
  toolIdentities: Map<string, CodexToolIdentity>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value)
    throw new TypeError(`${path} must be a non-empty string`);

  return value;
};

type ClaudeOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

const claudeOutputEffort = (
  effort: string | undefined,
): ClaudeOutputEffort | undefined => {
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }

  return undefined;
};

const appendMessage = (
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  blocks: AnthropicContentBlock[],
): void => {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);

  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
};

const codexImageBlock = (
  content: Record<string, unknown>,
): AnthropicContentBlock => {
  const imageUrl = requiredString(content.image_url, "input_image.image_url");
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/is.exec(
    imageUrl,
  );

  if (data) {
    return {
      type: "image",
      source: { type: "base64", media_type: data[1], data: data[2] },
    };
  }
  const url = new URL(imageUrl);

  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("input_image.image_url must use HTTPS or a data URL");

  return { type: "image", source: { type: "url", url: url.toString() } };
};

const messageBlocks = (
  item: Record<string, unknown>,
): AnthropicContentBlock[] => {
  if (!Array.isArray(item.content))
    throw new TypeError("message.content must be an array");

  return item.content.flatMap((raw, index): AnthropicContentBlock[] => {
    const content = asRecord(raw);

    if (!content)
      throw new TypeError(`message.content[${index}] must be an object`);
    if (content.type === "input_text" || content.type === "output_text") {
      return [{ type: "text", text: requiredString(content.text, "text") }];
    }
    if (content.type === "input_image") return [codexImageBlock(content)];
    if (content.type === "input_audio")
      throw new TypeError(
        "Audio input is not supported by Claude subscriptions",
      );
    throw new TypeError(`Unsupported message content: ${String(content.type)}`);
  });
};

const agentMessageBlocks = (
  item: Record<string, unknown>,
): AnthropicContentBlock[] => {
  if (!Array.isArray(item.content))
    throw new TypeError("agent_message.content must be an array");
  const blocks = item.content.flatMap((raw, index): AnthropicContentBlock[] => {
    const content = asRecord(raw);

    if (!content)
      throw new TypeError(`agent_message.content[${index}] must be an object`);
    if (content.type === "input_text") {
      return typeof content.text === "string" && content.text
        ? [{ type: "text", text: content.text }]
        : [];
    }
    if (content.type === "encrypted_content") {
      return [{ type: "text", text: "[encrypted sub-agent content omitted]" }];
    }
    throw new TypeError(
      `Unsupported agent message content: ${String(content.type)}`,
    );
  });

  return blocks.length > 0
    ? blocks
    : [{ type: "text", text: "(sub-agent message received)" }];
};

const toolResultContent = (
  output: unknown,
): string | AnthropicContentBlock[] => {
  if (typeof output === "string") return output || "(empty tool output)";
  if (!Array.isArray(output)) return "(empty tool output)";
  const blocks = output.flatMap((raw, index): AnthropicContentBlock[] => {
    const content = asRecord(raw);

    if (!content)
      throw new TypeError(`tool output[${index}] must be an object`);
    if (["input_text", "output_text", "text"].includes(String(content.type))) {
      return typeof content.text === "string" && content.text
        ? [{ type: "text", text: content.text }]
        : [];
    }
    if (content.type === "input_image") return [codexImageBlock(content)];
    if (content.type === "encrypted_content") {
      return [{ type: "text", text: "[encrypted content omitted]" }];
    }
    if (content.type === "refusal") {
      return typeof content.refusal === "string" && content.refusal
        ? [{ type: "text", text: `[refusal: ${content.refusal}]` }]
        : [];
    }
    throw new TypeError(
      `Unsupported tool output content: ${String(content.type)}`,
    );
  });

  return blocks.length > 0 ? blocks : "(empty tool output)";
};

const functionArguments = (value: unknown): Record<string, unknown> => {
  const parsed = JSON.parse(requiredString(value, "function_call.arguments"));

  if (!asRecord(parsed))
    throw new TypeError("function_call.arguments must encode an object");

  return parsed;
};

const toolLookupKey = (name: string, namespace?: string): string =>
  `${namespace ?? ""}\u0000${name}`;

const nativeMcpToolName = (
  name: string,
  namespace: string | undefined,
  used: ReadonlyMap<string, CodexToolIdentity>,
): string => {
  let collisionAttempt = 0;
  let candidate: string;

  do {
    candidate = claudeCodeMcpToolName(
      name,
      namespace ?? "codex",
      collisionAttempt++,
    );
  } while (used.has(candidate));

  return candidate;
};

function collectCodexTools(request: CodexResponsesRequest): {
  tools: AnthropicTool[];
  identities: Map<string, CodexToolIdentity>;
  wireNameByIdentity: Map<string, string>;
} {
  const definitions: Array<Record<string, unknown>> = [
    ...(request.tools ?? []),
  ];

  for (const item of request.input) {
    if (item.type === "additional_tools" && Array.isArray(item.tools)) {
      definitions.push(...(item.tools as Array<Record<string, unknown>>));
    }
  }
  const tools: AnthropicTool[] = [];
  const identities = new Map<string, CodexToolIdentity>();
  const wireNameByIdentity = new Map<string, string>();
  const add = (definition: Record<string, unknown>, namespace?: string) => {
    const kind = definition.type;

    if (kind === "namespace") {
      const nestedNamespace = requiredString(definition.name, "namespace.name");

      if (!Array.isArray(definition.tools))
        throw new TypeError("namespace.tools must be an array");
      for (const nested of definition.tools) {
        const record = asRecord(nested);

        if (!record) throw new TypeError("namespace tool must be an object");
        add(record, nestedNamespace);
      }

      return;
    }
    if (kind !== "function" && kind !== "custom") return;
    const name = requiredString(definition.name, "tool.name");
    const identity: CodexToolIdentity = {
      kind,
      name,
      ...(namespace ? { namespace } : {}),
    };
    const lookupKey = toolLookupKey(name, namespace);

    const existingWireName = wireNameByIdentity.get(lookupKey);

    if (existingWireName) {
      const existingIdentity = identities.get(existingWireName);

      if (existingIdentity?.kind !== kind) {
        throw new TypeError(
          "Function and custom tools cannot share a name and namespace",
        );
      }

      return;
    }
    const wireName = nativeMcpToolName(name, namespace, identities);
    const description =
      typeof definition.description === "string"
        ? definition.description
        : undefined;
    const inputSchema =
      kind === "function" && asRecord(definition.parameters)
        ? normalizeObjectRootToolInputSchema(
            definition.parameters as Record<string, unknown>,
          )
        : {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          };

    tools.push({
      name: wireName,
      ...(description ? { description } : {}),
      input_schema: inputSchema,
    });
    identities.set(wireName, identity);
    wireNameByIdentity.set(lookupKey, wireName);
  };

  for (const definition of definitions) add(definition);

  return { tools, identities, wireNameByIdentity };
}

export function codexToAnthropic(
  source: CodexResponsesRequest,
  options: { model: string; maxOutputTokens: number },
): CodexToAnthropicResult {
  const { tools, identities, wireNameByIdentity } = collectCodexTools(source);
  const messages: AnthropicMessage[] = [];
  const system: string[] = source.instructions ? [source.instructions] : [];
  const wireName = (
    name: string,
    namespace: string | undefined,
    kind: CodexToolIdentity["kind"],
  ): string => {
    const key = toolLookupKey(name, namespace);
    const existing = wireNameByIdentity.get(key);

    if (existing) return existing;
    const generated = nativeMcpToolName(name, namespace, identities);

    identities.set(generated, {
      kind,
      name,
      ...(namespace ? { namespace } : {}),
    });
    wireNameByIdentity.set(key, generated);

    return generated;
  };

  for (const item of source.input) {
    const type = item.type;

    if (type === "additional_tools" || type === "reasoning") continue;
    if (type === "message") {
      const role = requiredString(item.role, "message.role");
      const blocks = messageBlocks(item);

      if (role === "developer" || role === "system") {
        system.push(
          blocks
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("\n"),
        );
      } else if (role === "user" || role === "assistant") {
        appendMessage(messages, role, blocks);
      } else {
        throw new TypeError(`Unsupported message role: ${role}`);
      }
      continue;
    }
    if (type === "agent_message") {
      appendMessage(messages, "user", agentMessageBlocks(item));
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const name = requiredString(item.name, `${type}.name`);
      const namespace =
        typeof item.namespace === "string" ? item.namespace : undefined;
      const callId = requiredString(item.call_id, `${type}.call_id`);
      const input =
        type === "function_call"
          ? functionArguments(item.arguments)
          : { input: requiredString(item.input, "custom_tool_call.input") };

      appendMessage(messages, "assistant", [
        {
          type: "tool_use",
          id: callId,
          name: wireName(
            name,
            namespace,
            type === "function_call" ? "function" : "custom",
          ),
          input,
        },
      ]);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      appendMessage(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: requiredString(item.call_id, `${type}.call_id`),
          content: toolResultContent(item.output),
        },
      ]);
      continue;
    }
    if (type === "compaction" || type === "context_compaction") continue;
    throw new TypeError(
      `Codex input item '${String(type)}' is not portable to Claude`,
    );
  }
  if (messages.length === 0)
    throw new TypeError("Codex request has no Claude-compatible messages");
  if (messages.at(-1)?.role === "assistant") {
    messages.push({ role: "user", content: "(continue)" });
  }
  const effort = source.reasoning?.effort;
  const outputEffort = claudeOutputEffort(effort);
  const thinking =
    effort && !["none", "disabled"].includes(effort)
      ? ({ type: "adaptive" } as const)
      : undefined;
  const toolChoice =
    source.tool_choice === "required"
      ? ({ type: "any" } as const)
      : source.tool_choice === "none"
        ? ({ type: "none" } as const)
        : ({ type: "auto" } as const);
  const systemText = system.filter(Boolean).join("\n\n");
  const cachedTools = tools.map((tool, index) =>
    index === tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool,
  );

  return {
    request: {
      model: options.model,
      messages,
      max_tokens: options.maxOutputTokens,
      stream: true,
      ...(systemText
        ? {
            system: [
              {
                type: "text",
                text: systemText,
                cache_control: { type: "ephemeral" },
              },
            ],
          }
        : {}),
      ...(cachedTools.length > 0
        ? { tools: cachedTools, tool_choice: toolChoice }
        : {}),
      ...(thinking ? { thinking } : {}),
      ...(thinking
        ? {
            context_management: {
              edits: [
                {
                  type: "clear_thinking_20251015" as const,
                  keep: "all" as const,
                },
              ],
            },
          }
        : {}),
      ...(outputEffort ? { output_config: { effort: outputEffort } } : {}),
    },
    toolIdentities: identities,
  };
}

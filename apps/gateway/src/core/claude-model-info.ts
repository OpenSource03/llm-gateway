import { claudeCodeModelId } from "./claude-model-id";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingMode = "adaptive" | "enabled";

interface ClaudeGatewayModel {
  capabilities: unknown;
  contextWindow: number | null;
  displayName: string;
  lastSeenAt: Date | string;
  maxOutputTokens: number | null;
  provider: string;
  publicModelId: string;
  upstreamModelId: string;
}

const supported = (value: boolean) => ({ supported: value });

const stringSet = (value: unknown): ReadonlySet<string> =>
  new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
  );

const modelCapabilities = (model: ClaudeGatewayModel) => {
  const stored =
    model.capabilities &&
    typeof model.capabilities === "object" &&
    !Array.isArray(model.capabilities)
      ? (model.capabilities as Record<string, unknown>)
      : {};
  const modalities = Array.isArray(stored.inputModalities)
    ? stored.inputModalities
    : [];
  const reasoning = stored.reasoning === true;
  const reasoningEfforts = stringSet(stored.reasoningEfforts);
  const thinkingModes = stringSet(stored.thinkingModes);
  const contextManagement =
    stored.contextManagement &&
    typeof stored.contextManagement === "object" &&
    !Array.isArray(stored.contextManagement)
      ? (stored.contextManagement as Record<string, unknown>)
      : {};
  const supportsClearThinking =
    model.provider === "ANTHROPIC" && contextManagement.clearThinking === true;
  const supportsCompaction =
    model.provider === "ANTHROPIC" && contextManagement.compact === true;
  const effortCapability = (effort: ReasoningEffort) =>
    supported(reasoning && reasoningEfforts.has(effort));
  const thinkingCapability = (mode: ThinkingMode) =>
    supported(reasoning && thinkingModes.has(mode));

  return {
    batch: supported(false),
    citations: supported(false),
    code_execution: supported(false),
    context_management: {
      supported: supportsClearThinking || supportsCompaction,
      clear_thinking_20251015: supportsClearThinking ? supported(true) : null,
      clear_tool_uses_20250919: null,
      compact_20260112: supportsCompaction ? supported(true) : null,
    },
    effort: {
      supported: reasoningEfforts.size > 0,
      low: effortCapability("low"),
      medium: effortCapability("medium"),
      high: effortCapability("high"),
      xhigh: reasoningEfforts.has("xhigh") ? effortCapability("xhigh") : null,
      max: effortCapability("max"),
    },
    image_input: supported(modalities.includes("image")),
    pdf_input: supported(false),
    structured_outputs: supported(false),
    thinking: {
      supported: thinkingModes.size > 0,
      types: {
        adaptive: thinkingCapability("adaptive"),
        enabled: thinkingCapability("enabled"),
      },
    },
  };
};

/** Anthropic ModelInfo plus backward-compatible OpenAI list fields. */
export function claudeCodeModelInfo(model: ClaudeGatewayModel) {
  const id = claudeCodeModelId(model);
  const lastSeenAt = new Date(model.lastSeenAt);
  const createdAt = Number.isFinite(lastSeenAt.getTime())
    ? lastSeenAt
    : new Date(0);

  return {
    id,
    type: "model" as const,
    object: "model" as const,
    created: Math.floor(createdAt.getTime() / 1_000),
    created_at: createdAt.toISOString(),
    owned_by: "llm-gateway",
    display_name:
      model.contextWindow !== null && model.contextWindow >= 1_000_000
        ? `${model.displayName} · 1M`
        : model.displayName,
    provider: model.provider.toLowerCase(),
    capabilities: modelCapabilities(model),
    max_input_tokens: model.contextWindow,
    max_tokens: model.maxOutputTokens,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
  };
}

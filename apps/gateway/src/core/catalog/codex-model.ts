import type { CodexCatalogCapabilities } from "../providers/types";

const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface SyntheticCodexModelSource {
  capabilities: unknown;
  contextWindow: number | null;
  description: string | null;
  displayName: string;
  provider: string;
  publicModelId: string;
  upstreamModelId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Distinguish complete provider-native ModelInfo rows from the abbreviated
 * metadata fragments that some provider catalog routes return for hidden
 * models. Strict Codex clients reject the entire catalog if one required
 * ModelInfo field is absent.
 */
export function hasRequiredNativeCodexMetadata(
  entry: Readonly<Record<string, unknown>>,
): boolean {
  const truncation = entry.truncation_policy;

  return (
    Array.isArray(entry.supported_reasoning_levels) &&
    typeof entry.shell_type === "string" &&
    typeof entry.supported_in_api === "boolean" &&
    Number.isInteger(entry.priority) &&
    typeof entry.support_verbosity === "boolean" &&
    isRecord(truncation) &&
    (truncation.mode === "bytes" || truncation.mode === "tokens") &&
    Number.isInteger(truncation.limit) &&
    Array.isArray(entry.experimental_supported_tools)
  );
}

export function codexCatalogModelId(
  model: Pick<SyntheticCodexModelSource, "publicModelId" | "upstreamModelId">,
  clientCapabilities: CodexCatalogCapabilities,
): string {
  return clientCapabilities.modelIdSource === "upstream"
    ? model.upstreamModelId
    : model.publicModelId;
}

/** Publish one routable provider-native row without borrowing model metadata. */
export function publishNativeCodexModel(
  entry: Readonly<Record<string, unknown>>,
  modelId: string,
): Record<string, unknown> {
  return {
    ...entry,
    slug: modelId,
    display_name:
      typeof entry.display_name === "string" ? entry.display_name : modelId,
    visibility: "list",
  };
}

/** Build one provider-neutral Codex catalog row without authoring a base prompt. */
export function buildSyntheticCodexModel(
  model: SyntheticCodexModelSource,
  priority: number,
  clientCapabilities: CodexCatalogCapabilities,
): Record<string, unknown> {
  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? (model.capabilities as Record<string, unknown>)
      : {};
  const modalities = Array.isArray(capabilities.inputModalities)
    ? capabilities.inputModalities.filter(
        (value): value is "text" | "image" =>
          value === "text" || value === "image",
      )
    : ["text"];
  const reasoning = capabilities.reasoning === true;
  const providerEffortValues = Array.isArray(capabilities.reasoningEfforts)
    ? capabilities.reasoningEfforts
    : null;
  const hasProviderEffortMetadata = providerEffortValues !== null;
  const providerEfforts = new Set(
    (providerEffortValues ?? []).filter(
      (value: unknown): value is string => typeof value === "string",
    ),
  );
  const reasoningEfforts = CODEX_REASONING_EFFORTS.filter((effort) =>
    providerEfforts.has(effort),
  );

  if (
    reasoning &&
    !hasProviderEffortMetadata &&
    reasoningEfforts.length === 0
  ) {
    // Old rows may predate precise effort metadata. Keep one honest setting
    // until the next provider refresh fills in the exact list.
    reasoningEfforts.push("medium");
  }

  const defaultReasoningLevel = reasoningEfforts.includes("medium")
    ? "medium"
    : (reasoningEfforts[0] ?? "none");

  return {
    slug: codexCatalogModelId(model, clientCapabilities),
    display_name: model.displayName,
    description: model.description,
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: `${effort} reasoning effort`,
    })),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: {
      persistent_instructions: null,
      // The provider adapter owns upstream system behavior. The catalog must
      // not impersonate Codex or invent a model personality.
      instructions_template: "",
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
      multi_agent: null,
      token_budget: null,
      confirmation_policies: null,
      guardian_v2: null,
    },
    base_instructions: "",
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    ...(clientCapabilities.webSearchToolType
      ? { web_search_tool_type: clientCapabilities.webSearchToolType }
      : {}),
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: modalities.includes("image"),
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: modalities,
    supports_search_tool: clientCapabilities.supportsSearchTool,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: clientCapabilities.toolMode,
    // Codex selects its collaboration tool surface from ModelInfo before the
    // request reaches the gateway. Synthetic provider models use the same V2
    // harness as native compatible models; provider adapters still own the
    // actual inference protocol and model behavior.
    multi_agent_version: "v2",
  };
}

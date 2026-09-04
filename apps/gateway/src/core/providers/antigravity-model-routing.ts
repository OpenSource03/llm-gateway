import type { DiscoveredModel, ModelReasoningEffort } from "./types";

import { isRecord, providerModelId } from "./shared";

const REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const DEFAULT_EFFORT_ORDER: readonly ModelReasoningEffort[] = [
  "medium",
  "high",
  "low",
  "minimal",
  "xhigh",
  "max",
];
const ROUTING_METADATA_KIND = "antigravity-reasoning-routes-v1";

interface ModelVariant {
  rawId: string;
  baseName: string;
  effort?: ModelReasoningEffort;
  model: DiscoveredModel;
}

interface ParsedRoutingMetadata {
  defaultUpstreamId: string;
  reasoningEfforts: Partial<Record<ModelReasoningEffort, string>>;
}

const normalizeAntigravityEffort = (
  value: unknown,
): ModelReasoningEffort | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized === "xhigh") return "xhigh";

  return REASONING_EFFORTS.find((effort) => effort === normalized);
};

const variantFromModel = (model: DiscoveredModel): ModelVariant => {
  const match =
    /^(.*?)\s*\((minimal|low|medium|high|x[\s_-]*high|max)\)\s*$/iu.exec(
      model.name,
    );
  const effort = normalizeAntigravityEffort(match?.[2]);
  const baseName = match?.[1]?.trim();

  return effort && baseName
    ? { rawId: model.upstreamId, baseName, effort, model }
    : { rawId: model.upstreamId, baseName: model.name, model };
};

const groupKey = (name: string): string =>
  name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

const logicalIdSlug = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");

const isEffortGroup = (variants: ModelVariant[]): boolean =>
  new Set(variants.flatMap(({ effort }) => (effort ? [effort] : []))).size > 1;

const uniqueLogicalId = (
  baseName: string,
  variants: ModelVariant[],
  claimedIds: Set<string>,
): string => {
  const plainVariant = [...variants]
    .filter(({ effort }) => effort === undefined)
    .sort((left, right) => left.rawId.localeCompare(right.rawId))[0];
  const base =
    providerModelId(plainVariant?.rawId) ??
    providerModelId(logicalIdSlug(baseName)) ??
    variants[0]!.rawId;
  let candidate = base;
  let collision = 1;

  while (claimedIds.has(candidate)) {
    collision += 1;
    candidate = `${base}-reasoning${collision === 2 ? "" : `-${collision}`}`;
  }
  claimedIds.add(candidate);

  return candidate;
};

const preferredRoute = (
  variants: ModelVariant[],
  logicalId: string,
  effort: ModelReasoningEffort,
): ModelVariant =>
  [...variants].sort((left, right) => {
    const score = (variant: ModelVariant): number => {
      if (variant.rawId === `${logicalId}-${effort}`) return 0;
      if (variant.rawId.endsWith(`-${effort}`)) return 1;

      return 2;
    };
    const scoreDifference = score(left) - score(right);

    return scoreDifference || left.rawId.localeCompare(right.rawId);
  })[0]!;

const commonMinimum = (
  models: DiscoveredModel[],
  field: "contextWindow" | "maxOutputTokens",
): number | undefined => {
  const values = models.map((model) => model[field]);

  return values.every((value): value is number => value !== undefined)
    ? Math.min(...values)
    : undefined;
};

const commonModalities = (
  models: DiscoveredModel[],
): Array<"text" | "image"> => {
  const [first, ...rest] = models;

  if (!first) return ["text"];
  const intersection = first.inputModalities.filter((modality) =>
    rest.every((model) => model.inputModalities.includes(modality)),
  );

  return intersection.length ? intersection : ["text"];
};

const collapseGroup = (
  variants: ModelVariant[],
  logicalId: string,
): DiscoveredModel => {
  const sorted = [...variants].sort((left, right) =>
    left.rawId.localeCompare(right.rawId),
  );
  const routes: Partial<Record<ModelReasoningEffort, string>> = {};

  for (const effort of REASONING_EFFORTS) {
    const matching = sorted.filter((variant) => variant.effort === effort);

    if (matching.length > 0) {
      routes[effort] = preferredRoute(matching, logicalId, effort).rawId;
    }
  }
  const plainDefault = sorted.find(({ effort }) => effort === undefined)?.rawId;
  const preferredDefaultEffort = DEFAULT_EFFORT_ORDER.find(
    (effort) => routes[effort] !== undefined,
  );
  const defaultUpstreamId =
    plainDefault ??
    (preferredDefaultEffort ? routes[preferredDefaultEffort] : undefined) ??
    sorted[0]!.rawId;
  const defaultReasoningEffort = plainDefault
    ? undefined
    : preferredDefaultEffort;
  const models = sorted.map(({ model }) => model);
  const contextWindow = commonMinimum(models, "contextWindow");
  const maxOutputTokens = commonMinimum(models, "maxOutputTokens");

  return {
    upstreamId: logicalId,
    name: sorted[0]!.baseName,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    inputModalities: commonModalities(models),
    reasoning: true,
    reasoningEfforts: REASONING_EFFORTS.filter((effort) => routes[effort]),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    thinkingModes: ["enabled"],
    providerMetadata: {
      kind: ROUTING_METADATA_KIND,
      defaultUpstreamId,
      reasoningEfforts: routes,
    },
    source: "live",
  };
};

/**
 * Antigravity publishes effort-specific route ids as separate catalog rows.
 * Collapse only unambiguous display-name families with at least two efforts;
 * all unrelated and future entries continue to pass through untouched.
 */
export function collapseAntigravityEffortVariants(
  discoveredModels: DiscoveredModel[],
): DiscoveredModel[] {
  const variants = discoveredModels.map(variantFromModel);
  const groups = new Map<string, ModelVariant[]>();

  for (const variant of variants) {
    const key = groupKey(variant.baseName);
    const group = groups.get(key);

    if (group) group.push(variant);
    else groups.set(key, [variant]);
  }
  const groupedKeys = new Set(
    [...groups.entries()]
      .filter(([, group]) => isEffortGroup(group))
      .map(([key]) => key),
  );
  const claimedIds = new Set(
    variants
      .filter((variant) => !groupedKeys.has(groupKey(variant.baseName)))
      .map(({ rawId }) => rawId),
  );
  const models: DiscoveredModel[] = [];

  for (const [key, group] of groups) {
    if (!groupedKeys.has(key)) {
      for (const variant of group) {
        models.push(variant.model);
      }
      continue;
    }
    const logicalId = uniqueLogicalId(group[0]!.baseName, group, claimedIds);

    models.push(collapseGroup(group, logicalId));
  }

  return models;
}

const parseRoutingMetadata = (
  providerMetadata: unknown,
): ParsedRoutingMetadata | undefined => {
  if (!isRecord(providerMetadata)) return undefined;
  if (providerMetadata.kind !== ROUTING_METADATA_KIND) return undefined;
  const defaultUpstreamId = providerModelId(providerMetadata.defaultUpstreamId);
  const rawRoutes = isRecord(providerMetadata.reasoningEfforts)
    ? providerMetadata.reasoningEfforts
    : null;

  if (!defaultUpstreamId || !rawRoutes) return undefined;
  const reasoningEfforts: Partial<Record<ModelReasoningEffort, string>> = {};

  for (const effort of REASONING_EFFORTS) {
    const route = providerModelId(rawRoutes[effort]);

    if (route) reasoningEfforts[effort] = route;
  }

  return { defaultUpstreamId, reasoningEfforts };
};

/** Map provider route ids back to the logical models used by quota scopes. */
export function antigravityRawRouteScopes(
  logicalModels: DiscoveredModel[],
): ReadonlyMap<string, string> {
  const scopes = new Map<string, string>();

  for (const model of logicalModels) {
    scopes.set(model.upstreamId, model.upstreamId);
    const routing = parseRoutingMetadata(model.providerMetadata);

    if (!routing) continue;
    scopes.set(routing.defaultUpstreamId, model.upstreamId);
    for (const route of Object.values(routing.reasoningEfforts)) {
      if (route) scopes.set(route, model.upstreamId);
    }
  }

  return scopes;
}

/** Select a provider route from trusted, persisted discovery metadata. */
export function selectAntigravityUpstreamModel(
  logicalUpstreamId: string,
  providerMetadata: unknown,
  requestedEffort: unknown,
): string {
  const routing = parseRoutingMetadata(providerMetadata);

  if (!routing) return logicalUpstreamId;
  const effort = normalizeAntigravityEffort(requestedEffort);
  const selected = effort ? routing.reasoningEfforts[effort] : undefined;

  return selected ?? routing.defaultUpstreamId;
}

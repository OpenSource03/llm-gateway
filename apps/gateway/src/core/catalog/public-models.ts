import type { GatewayClientPrincipal } from "../../control/client-keys.service";
import type { GatewayModelRow } from "../../control/models.service";
import type { CodexCatalogCapabilities } from "../providers/types";

import { listRoutableGatewayModels } from "../../control/models.service";
import { claudeCodeModelInfo } from "../claude-model-info";
import { llmGatewayPrisma } from "../db";
import { getProviderAdapter } from "../providers";
import { fromDbProvider } from "../providers/provider-id";

import {
  buildSyntheticCodexModel,
  codexCatalogModelId,
  hasRequiredNativeCodexMetadata,
  publishNativeCodexModel,
} from "./codex-model";

const keyAllowsModel = (
  principal: GatewayClientPrincipal,
  model: GatewayModelRow,
): boolean =>
  principal.allowAllModels ||
  principal.allowedModelIds.has(model.publicModelId);

const catalogCapabilities = (
  model: Pick<GatewayModelRow, "provider">,
): CodexCatalogCapabilities =>
  getProviderAdapter(fromDbProvider(model.provider)).codexCatalog;

const catalogModelId = (model: GatewayModelRow): string =>
  codexCatalogModelId(model, catalogCapabilities(model));

export async function publicClaudeGatewayModels(
  principal: GatewayClientPrincipal,
) {
  const models = await listRoutableGatewayModels();

  return models
    .filter((model) => keyAllowsModel(principal, model))
    .map(claudeCodeModelInfo);
}

/** Build the authenticated Codex catalog from every currently routable provider. */
export async function publicCodexGatewayModels(
  principal: GatewayClientPrincipal,
): Promise<Array<Record<string, unknown>>> {
  const routable = (await listRoutableGatewayModels()).filter((model) =>
    keyAllowsModel(principal, model),
  );

  if (routable.length === 0) return [];
  const accounts = await llmGatewayPrisma.gatewayProviderAccount.findMany({
    where: { enabled: true, status: "ACTIVE" },
    orderBy: { lastModelCatalogRefreshAt: "desc" },
    select: { provider: true, nativeModelCatalog: true },
  });
  const visibleModelIds = new Set(routable.map(catalogModelId));
  const modelsById = new Map<string, Record<string, unknown>>();

  for (const account of accounts) {
    if (!Array.isArray(account.nativeModelCatalog)) continue;
    const provider = fromDbProvider(account.provider);
    const capabilities = getProviderAdapter(provider).codexCatalog;

    for (const value of account.nativeModelCatalog) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const upstreamModelId =
        typeof entry.slug === "string" ? entry.slug : null;

      if (!upstreamModelId) continue;
      const publicModelId = `${provider}/${upstreamModelId}`;
      const modelId = codexCatalogModelId(
        { publicModelId, upstreamModelId },
        capabilities,
      );

      // Provider catalogs can contain hidden metadata fragments rather than
      // complete Codex ModelInfo rows. They are neither routable through this
      // key nor safe to return to strict Codex clients. A routable model with
      // no complete native row receives a provider-neutral row below.
      if (
        !visibleModelIds.has(modelId) ||
        modelsById.has(modelId) ||
        !hasRequiredNativeCodexMetadata(entry)
      ) {
        continue;
      }
      modelsById.set(modelId, publishNativeCodexModel(entry, modelId));
    }
  }

  for (const [index, model] of routable.entries()) {
    const capabilities = catalogCapabilities(model);
    const modelId = codexCatalogModelId(model, capabilities);

    if (!modelsById.has(modelId)) {
      modelsById.set(
        modelId,
        buildSyntheticCodexModel(model, 1_000 + index, capabilities),
      );
    }
  }

  return [...modelsById.values()];
}

import { canonicalGatewayModelIdFromClaudeCode } from "../core/claude-model-id";
import { llmGatewayPrisma } from "../core/db";
import { GatewayError } from "../core/errors";

import { refreshGatewayAccount } from "./accounts.service";

export interface GatewayModelRow {
  id: string;
  provider: string;
  upstreamModelId: string;
  publicModelId: string;
  displayName: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: unknown;
  enabled: boolean;
  aliases: string[];
  routingPoolId: string | null;
  eligibleAccountCount: number;
  catalogSource: string;
  lastSeenAt: string;
  staleAfter: string | null;
}

const modelInclude = (now = new Date()) =>
  ({
    aliases: {
      where: { enabled: true },
      orderBy: { createdAt: "asc" as const },
    },
    routingPool: { select: { id: true } },
    accountModels: {
      where: {
        available: true,
        lastSeenAt: {
          gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        },
        account: { enabled: true, status: "ACTIVE" as const },
      },
      select: { accountId: true },
    },
  }) as const;

type ModelRecord = Awaited<
  ReturnType<typeof llmGatewayPrisma.gatewayModel.findFirstOrThrow>
> & {
  aliases?: Array<{ alias: string }>;
  routingPool?: { id: string } | null;
  accountModels?: Array<{ accountId: string }>;
};

const publicModelCapabilities = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const capabilities = value as Record<string, unknown>;

  return {
    inputModalities: capabilities.inputModalities,
    reasoning: capabilities.reasoning,
    reasoningEfforts: capabilities.reasoningEfforts,
    thinkingModes: capabilities.thinkingModes,
    contextManagement: capabilities.contextManagement,
  };
};

const toRow = (model: ModelRecord): GatewayModelRow => ({
  id: model.id,
  provider: model.provider,
  upstreamModelId: model.upstreamModelId,
  publicModelId: model.publicModelId,
  displayName: model.displayName,
  description: model.description,
  contextWindow: model.contextWindow,
  maxOutputTokens: model.maxOutputTokens,
  // Native Codex catalog metadata is stored beside these fields but remains a
  // data-plane concern; do not send its large instruction templates to Admin.
  capabilities: publicModelCapabilities(model.capabilities),
  enabled: model.enabled,
  aliases: model.aliases?.map(({ alias }) => alias) ?? [],
  routingPoolId: model.routingPool?.id ?? null,
  eligibleAccountCount: model.accountModels?.length ?? 0,
  catalogSource: model.catalogSource,
  lastSeenAt: model.lastSeenAt.toISOString(),
  staleAfter: model.staleAfter?.toISOString() ?? null,
});

export const listGatewayModels = async (): Promise<GatewayModelRow[]> => {
  const models = await llmGatewayPrisma.gatewayModel.findMany({
    include: modelInclude(),
    orderBy: [{ provider: "asc" }, { displayName: "asc" }],
  });

  return models.map((model) => toRow(model as ModelRecord));
};

export const listRoutableGatewayModels = async (): Promise<
  GatewayModelRow[]
> => {
  const now = new Date();
  const models = await llmGatewayPrisma.gatewayModel.findMany({
    where: {
      enabled: true,
      OR: [{ staleAfter: null }, { staleAfter: { gt: now } }],
      routingPool: { is: { enabled: true } },
    },
    include: modelInclude(now),
    orderBy: [{ provider: "asc" }, { displayName: "asc" }],
  });
  const rows = await Promise.all(
    models.map(async (model) => {
      if (!model.routingPoolId) return null;
      const eligibleAccountCount =
        await llmGatewayPrisma.gatewayRoutingPoolMember.count({
          where: {
            routingPoolId: model.routingPoolId,
            enabled: true,
            account: {
              enabled: true,
              status: "ACTIVE",
              accountModels: {
                some: {
                  modelId: model.id,
                  available: true,
                  lastSeenAt: {
                    gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
                  },
                },
              },
            },
          },
        });

      return eligibleAccountCount > 0
        ? { ...toRow(model as ModelRecord), eligibleAccountCount }
        : null;
    }),
  );

  return rows.filter((row): row is GatewayModelRow => row !== null);
};

const MODEL_REFRESH_CONCURRENCY = 3;

export const refreshGatewayModels = async (): Promise<GatewayModelRow[]> => {
  const accounts = await llmGatewayPrisma.gatewayProviderAccount.findMany({
    where: { enabled: true },
    select: { id: true },
  });
  let cursor = 0;
  let failures = 0;
  const workers = Array.from(
    { length: Math.min(MODEL_REFRESH_CONCURRENCY, accounts.length) },
    async () => {
      while (cursor < accounts.length) {
        const account = accounts[cursor++];

        if (!account) return;
        try {
          await refreshGatewayAccount(account.id);
        } catch {
          failures += 1;
        }
      }
    },
  );

  await Promise.all(workers);
  if (failures > 0) {
    throw new GatewayError(
      `${accounts.length - failures} of ${accounts.length} account catalogs refreshed; ${failures} failed`,
      503,
      failures === accounts.length
        ? "MODEL_REFRESH_FAILED"
        : "MODEL_REFRESH_PARTIAL",
    );
  }

  return listGatewayModels();
};

export const updateGatewayModel = async (
  id: string,
  input: {
    enabled?: boolean;
    alias?: string | null;
    routingPoolId?: string | null;
  },
): Promise<GatewayModelRow> => {
  const existing = await llmGatewayPrisma.gatewayModel.findUnique({
    where: { id },
  });

  if (!existing) throw new GatewayError("Model not found", 404, "NOT_FOUND");
  if (input.routingPoolId) {
    const pool = await llmGatewayPrisma.gatewayRoutingPool.findUnique({
      where: { id: input.routingPoolId },
    });

    if (!pool || pool.provider !== existing.provider) {
      throw new GatewayError(
        "Routing pool must belong to the same provider as the model",
        400,
        "POOL_PROVIDER_MISMATCH",
      );
    }
  }

  await llmGatewayPrisma.$transaction(async (tx) => {
    if (input.alias) {
      await tx.$queryRaw`
        SELECT 1::int AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`llm-gateway-model-name:${input.alias}`}, 0)
        )
      `;
    }
    await tx.gatewayModel.update({
      where: { id },
      data: {
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.routingPoolId !== undefined && {
          routingPoolId: input.routingPoolId,
        }),
      },
    });

    if (input.alias !== undefined) {
      await tx.gatewayModelAlias.deleteMany({ where: { modelId: id } });
      if (input.alias) {
        const canonicalCollision = await tx.gatewayModel.findUnique({
          where: { publicModelId: input.alias },
          select: { id: true },
        });

        if (canonicalCollision) {
          throw new GatewayError(
            "Alias conflicts with a canonical model ID",
            409,
            "MODEL_ALIAS_COLLISION",
          );
        }
        const aliasCollision = await tx.gatewayModelAlias.findUnique({
          where: { alias: input.alias },
          select: { modelId: true },
        });

        if (aliasCollision) {
          throw new GatewayError(
            "Alias is already assigned to another model",
            409,
            "MODEL_ALIAS_COLLISION",
          );
        }
        await tx.gatewayModelAlias.create({
          data: { modelId: id, alias: input.alias },
        });
      }
    }
  });

  const updated = await llmGatewayPrisma.gatewayModel.findUniqueOrThrow({
    where: { id },
    include: modelInclude(),
  });

  return toRow(updated as ModelRecord);
};

export const resolveGatewayModel = async (requestedId: string) => {
  // Canonical IDs are authoritative. This also makes legacy conflicting alias
  // rows fail safe until an operator replaces them.
  const canonical = await llmGatewayPrisma.gatewayModel.findUnique({
    where: { publicModelId: requestedId },
  });
  const claudeCanonicalId = canonical
    ? null
    : canonicalGatewayModelIdFromClaudeCode(requestedId);
  const claudeCanonical = claudeCanonicalId
    ? await llmGatewayPrisma.gatewayModel.findUnique({
        where: { publicModelId: claudeCanonicalId },
      })
    : null;
  const alias =
    canonical || claudeCanonical
      ? null
      : await llmGatewayPrisma.gatewayModelAlias.findUnique({
          where: { alias: requestedId },
          include: { model: true },
        });
  const model =
    canonical ?? claudeCanonical ?? (alias?.enabled ? alias.model : null);

  if (!model || !model.enabled) {
    throw new GatewayError("Model not found", 404, "MODEL_NOT_FOUND");
  }
  if (model.staleAfter && model.staleAfter <= new Date()) {
    throw new GatewayError(
      "Model catalog entry is stale; refresh provider models",
      503,
      "MODEL_CATALOG_STALE",
    );
  }
  if (!model.routingPoolId) {
    throw new GatewayError(
      "Model has no routing pool",
      503,
      "MODEL_NOT_ROUTED",
    );
  }

  return model;
};

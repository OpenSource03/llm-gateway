import { llmGatewayPrisma } from "../core/db";

export interface GatewayRequestHistoryFilters {
  page: number;
  perPage: number;
  provider?: string;
  model?: string;
  outcome?: string;
  clientKeyId?: string;
}

export const listGatewayRequestHistory = async (
  filters: GatewayRequestHistoryFilters,
) => {
  const where = {
    ...(filters.provider && { provider: filters.provider }),
    ...(filters.model && { publicModelId: filters.model }),
    ...(filters.outcome && { outcome: filters.outcome }),
    ...(filters.clientKeyId && { clientKeyId: filters.clientKeyId }),
  };
  const [rows, total] = await Promise.all([
    llmGatewayPrisma.gatewayRequestLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
    llmGatewayPrisma.gatewayRequestLog.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      clientKeyId: row.clientKeyId,
      accountId: row.accountId,
      provider: row.provider,
      publicModelId: row.publicModelId,
      upstreamModelId: row.upstreamModelId,
      routingPolicy: row.routingPolicy,
      statusCode: row.statusCode,
      outcome: row.outcome,
      errorClass: row.errorClass,
      retryCount: row.retryCount,
      streamed: row.streamed,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens?.toString() ?? null,
      outputTokens: row.outputTokens?.toString() ?? null,
      cachedInputTokens: row.cachedInputTokens?.toString() ?? null,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    })),
    total,
  };
};

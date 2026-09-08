import type {
  GatewayUsageMetrics,
  GatewayUsageReport,
} from "@opensource03/llm-gateway-contracts";
import type { UsageQuery } from "./usage-query";
import { Prisma } from "../generated/prisma/client";
import { llmGatewayPrisma } from "../core/db";

type Aggregate = {
  kind: number;
  bucket: Date | null;
  accountId: string | null;
  provider: string | null;
  requests: bigint;
  successes: bigint;
  errors: bigint;
  pending: bigint;
  unknown: bigint;
  input: bigint;
  cached: bigint;
  output: bigint;
  reserved: bigint;
  latency: number | null;
};
const metrics = (row?: Aggregate): GatewayUsageMetrics => ({
  requestCount: Number(row?.requests ?? 0),
  successCount: Number(row?.successes ?? 0),
  errorCount: Number(row?.errors ?? 0),
  pendingCount: Number(row?.pending ?? 0),
  unknownUsageCount: Number(row?.unknown ?? 0),
  inputTokens: String(row?.input ?? 0),
  cachedInputTokens: String(row?.cached ?? 0),
  outputTokens: String(row?.output ?? 0),
  totalTokens: String(
    (row?.input ?? 0n) + (row?.cached ?? 0n) + (row?.output ?? 0n),
  ),
  reservedTokens: String(row?.reserved ?? 0),
  averageLatencyMs: row?.latency == null ? null : Math.round(row.latency),
});

/** Aggregate metadata in PostgreSQL; never load paginated history or content into the browser. */
export const getGatewayUsage = async (
  query: UsageQuery,
  includeAccountLabels = false,
): Promise<GatewayUsageReport> => {
  const conditions = [
    Prisma.sql`"startedAt" >= ${query.from}`,
    Prisma.sql`"startedAt" < ${query.to}`,
  ];
  if (query.provider) conditions.push(Prisma.sql`provider = ${query.provider}`);
  if (query.account_id)
    conditions.push(Prisma.sql`"accountId" = ${query.account_id}`);
  if (query.model)
    conditions.push(Prisma.sql`"publicModelId" = ${query.model}`);
  if (query.client_key_id)
    conditions.push(Prisma.sql`"clientKeyId" = ${query.client_key_id}`);
  return llmGatewayPrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '10000', true)`;
      const rows = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      WITH filtered AS (
        SELECT *, date_trunc(${query.interval}, "startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket
        FROM "GatewayRequestLog" WHERE ${Prisma.join(conditions, " AND ")}
      )
      SELECT GROUPING(bucket, "accountId", provider)::int AS kind,
        bucket, "accountId", provider, count(*)::bigint AS requests,
        count(*) FILTER (WHERE outcome = 'success')::bigint AS successes,
        count(*) FILTER (WHERE outcome NOT IN ('success', 'started'))::bigint AS errors,
        count(*) FILTER (WHERE outcome = 'started')::bigint AS pending,
        count(*) FILTER (WHERE outcome = 'stream_error' OR "inputTokens" IS NULL OR "outputTokens" IS NULL)::bigint AS unknown,
        COALESCE(sum("inputTokens") FILTER (WHERE outcome NOT IN ('stream_error', 'started')), 0)::bigint AS input,
        COALESCE(sum("cachedInputTokens") FILTER (WHERE outcome NOT IN ('stream_error', 'started')), 0)::bigint AS cached,
        COALESCE(sum("outputTokens") FILTER (WHERE outcome NOT IN ('stream_error', 'started')), 0)::bigint AS output,
        COALESCE(sum(COALESCE("inputTokens", 0) + COALESCE("cachedInputTokens", 0) + COALESCE("outputTokens", 0))
          FILTER (WHERE outcome IN ('stream_error', 'started')), 0)::bigint AS reserved,
        avg("latencyMs") FILTER (WHERE outcome <> 'started')::float8 AS latency
      FROM filtered GROUP BY GROUPING SETS ((), (bucket), ("accountId", provider))
    `);
      const byBucket = new Map(
        rows
          .filter((row) => row.kind === 3)
          .map((row) => [row.bucket!.toISOString(), row]),
      );
      const step = query.interval === "hour" ? 3_600_000 : 86_400_000;
      const series: GatewayUsageReport["series"] = [];
      for (
        let time = Math.floor(query.from.getTime() / step) * step;
        time < query.to.getTime();
        time += step
      ) {
        const bucket = new Date(time).toISOString();
        series.push({ bucket, ...metrics(byBucket.get(bucket)) });
      }
      const accountRows = rows
        .filter((row) => row.kind === 4)
        .sort((a, b) => {
          const delta =
            b.input + b.cached + b.output - (a.input + a.cached + a.output);
          return delta > 0n
            ? 1
            : delta < 0n
              ? -1
              : Number(b.requests - a.requests) ||
                `${a.accountId}/${a.provider}`.localeCompare(
                  `${b.accountId}/${b.provider}`,
                );
        });
      const top = accountRows.slice(0, 100);
      const accounts = includeAccountLabels
        ? await tx.gatewayProviderAccount.findMany({
            where: {
              id: {
                in: top.flatMap((row) =>
                  row.accountId ? [row.accountId] : [],
                ),
              },
            },
            select: { id: true, displayName: true, email: true },
          })
        : [];
      const labels = new Map(
        accounts.map((account) => [
          account.id,
          account.displayName || account.email || account.id,
        ]),
      );
      return {
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        interval: query.interval,
        summary: metrics(rows.find((row) => row.kind === 7)),
        series,
        accounts: top.map((row) => ({
          ...metrics(row),
          accountId: row.accountId,
          provider: row.provider,
          accountLabel: row.accountId
            ? (labels.get(row.accountId) ?? row.accountId)
            : "Unassigned",
        })),
        accountCount: accountRows.length,
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 15_000 },
  );
};

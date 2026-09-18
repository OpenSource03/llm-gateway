import type {
  GatewayUsageBucket,
  GatewayUsageGroup,
  GatewayUsageGroupBy,
  GatewayUsageMetrics,
  GatewayUsageReport,
} from "@opensource03/llm-gateway-contracts";
import type { UsageQuery } from "./usage-query";
import { Prisma } from "../generated/prisma/client";
import { llmGatewayPrisma } from "../core/db";

type Totals = {
  requests: bigint;
  successes: bigint;
  errors: bigint;
  pending: bigint;
  unknown: bigint;
  input: bigint;
  cached: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  cacheUnsplit: bigint;
  output: bigint;
  reserved: bigint;
  latency: number | null;
};
type Aggregate = Totals & {
  kind: number;
  bucket: Date | null;
  accountId: string | null;
  provider: string | null;
};
type GroupAggregate = Totals & {
  kind: number;
  bucket: Date | null;
  group: string | null;
};

/** Ranked groups returned with their own series; the rest merge into one. */
const TOP_GROUPS = 8;
const GROUP_COLUMN: Record<GatewayUsageGroupBy, Prisma.Sql> = {
  account: Prisma.raw(`"accountId"`),
  client_key: Prisma.raw(`"clientKeyId"`),
  model: Prisma.raw(`"publicModelId"`),
  provider: Prisma.raw(`provider`),
};
const accounted = Prisma.sql`outcome NOT IN ('stream_error', 'started')`;
const METRIC_COLUMNS = Prisma.sql`count(*)::bigint AS requests,
  count(*) FILTER (WHERE outcome = 'success')::bigint AS successes,
  count(*) FILTER (WHERE outcome NOT IN ('success', 'started'))::bigint AS errors,
  count(*) FILTER (WHERE outcome = 'started')::bigint AS pending,
  count(*) FILTER (WHERE outcome = 'stream_error' OR "inputTokens" IS NULL OR "outputTokens" IS NULL)::bigint AS unknown,
  COALESCE(sum("inputTokens") FILTER (WHERE ${accounted}), 0)::bigint AS input,
  COALESCE(sum("cachedInputTokens") FILTER (WHERE ${accounted}), 0)::bigint AS cached,
  COALESCE(sum("cacheReadInputTokens") FILTER (WHERE ${accounted}), 0)::bigint AS "cacheRead",
  COALESCE(sum("cacheWriteInputTokens") FILTER (WHERE ${accounted}), 0)::bigint AS "cacheWrite",
  COALESCE(sum("cachedInputTokens") FILTER (WHERE ${accounted}
    AND "cacheReadInputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL), 0)::bigint AS "cacheUnsplit",
  COALESCE(sum("outputTokens") FILTER (WHERE ${accounted}), 0)::bigint AS output,
  COALESCE(sum(COALESCE("inputTokens", 0) + COALESCE("cachedInputTokens", 0) + COALESCE("outputTokens", 0))
    FILTER (WHERE outcome IN ('stream_error', 'started')), 0)::bigint AS reserved,
  avg("latencyMs") FILTER (WHERE outcome <> 'started')::float8 AS latency`;

const ZERO: Totals = {
  requests: 0n,
  successes: 0n,
  errors: 0n,
  pending: 0n,
  unknown: 0n,
  input: 0n,
  cached: 0n,
  cacheRead: 0n,
  cacheWrite: 0n,
  cacheUnsplit: 0n,
  output: 0n,
  reserved: 0n,
  latency: null,
};
const tokens = (row: Totals) => row.input + row.cached + row.output;
const metrics = (row: Totals = ZERO): GatewayUsageMetrics => ({
  requestCount: Number(row.requests),
  successCount: Number(row.successes),
  errorCount: Number(row.errors),
  pendingCount: Number(row.pending),
  unknownUsageCount: Number(row.unknown),
  inputTokens: String(row.input),
  cachedInputTokens: String(row.cached),
  cacheReadTokens: String(row.cacheRead),
  cacheWriteTokens: String(row.cacheWrite),
  cacheUnsplitTokens: String(row.cacheUnsplit),
  outputTokens: String(row.output),
  totalTokens: String(tokens(row)),
  reservedTokens: String(row.reserved),
  averageLatencyMs: row.latency == null ? null : Math.round(row.latency),
});
/** Sum ranked-out groups; latency is request-weighted over completed requests. */
const combine = (rows: Totals[]): Totals => {
  const total = rows.reduce<Totals>(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      successes: sum.successes + row.successes,
      errors: sum.errors + row.errors,
      pending: sum.pending + row.pending,
      unknown: sum.unknown + row.unknown,
      input: sum.input + row.input,
      cached: sum.cached + row.cached,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      cacheUnsplit: sum.cacheUnsplit + row.cacheUnsplit,
      output: sum.output + row.output,
      reserved: sum.reserved + row.reserved,
      latency: null,
    }),
    ZERO,
  );
  const weighted = rows.filter((row) => row.latency != null);
  const weight = weighted.reduce(
    (sum, row) => sum + Number(row.requests - row.pending),
    0,
  );

  return {
    ...total,
    latency: weight
      ? weighted.reduce(
          (sum, row) => sum + row.latency! * Number(row.requests - row.pending),
          0,
        ) / weight
      : null,
  };
};
const byUsage = (a: Totals, b: Totals) => {
  const delta = tokens(b) - tokens(a);

  return delta > 0n ? 1 : delta < 0n ? -1 : Number(b.requests - a.requests);
};

/** Aggregate metadata in PostgreSQL; never load paginated history or content into the browser. */
export const getGatewayUsage = async (
  query: UsageQuery,
  labels: { accounts: boolean; clientKeys: boolean } = {
    accounts: false,
    clientKeys: false,
  },
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
  // Testing keys are logged but never counted unless explicitly requested.
  if (!query.include_testing) conditions.push(Prisma.sql`testing = false`);
  const filtered = Prisma.sql`filtered AS (
    SELECT *, date_trunc(${query.interval}, "startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket
    FROM "GatewayRequestLog" WHERE ${Prisma.join(conditions, " AND ")}
  )`;
  const step = query.interval === "hour" ? 3_600_000 : 86_400_000;
  const buckets: string[] = [];
  for (
    let time = Math.floor(query.from.getTime() / step) * step;
    time < query.to.getTime();
    time += step
  ) {
    buckets.push(new Date(time).toISOString());
  }
  const series = (byBucket: Map<string, Totals>): GatewayUsageBucket[] =>
    buckets.map((bucket) => ({ bucket, ...metrics(byBucket.get(bucket)) }));

  return llmGatewayPrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '10000', true)`;
      const rows = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      WITH ${filtered}
      SELECT GROUPING(bucket, "accountId", provider)::int AS kind,
        bucket, "accountId", provider, ${METRIC_COLUMNS}
      FROM filtered GROUP BY GROUPING SETS ((), (bucket), ("accountId", provider))
    `);
      const accountRows = rows
        .filter((row) => row.kind === 4)
        .sort(
          (a, b) =>
            byUsage(a, b) ||
            `${a.accountId}/${a.provider}`.localeCompare(
              `${b.accountId}/${b.provider}`,
            ),
        );
      const top = accountRows.slice(0, 100);
      const groupRows = query.group_by
        ? await tx.$queryRaw<GroupAggregate[]>(Prisma.sql`
          WITH ${filtered}
          SELECT GROUPING(bucket)::int AS kind, bucket,
            ${GROUP_COLUMN[query.group_by]}::text AS "group", ${METRIC_COLUMNS}
          FROM filtered GROUP BY GROUPING SETS ((${GROUP_COLUMN[query.group_by]}), (${GROUP_COLUMN[query.group_by]}, bucket))
        `)
        : [];
      const groupTotals = groupRows
        .filter((row) => row.kind === 1)
        .sort(
          (a, b) =>
            byUsage(a, b) || String(a.group).localeCompare(String(b.group)),
        );
      const ranked = groupTotals.slice(0, TOP_GROUPS);
      const rest = groupTotals.slice(TOP_GROUPS);
      const accountIds = [
        ...top.flatMap((row) => (row.accountId ? [row.accountId] : [])),
        ...(query.group_by === "account"
          ? ranked.flatMap((row) => (row.group ? [row.group] : []))
          : []),
      ];
      const accounts = labels.accounts
        ? await tx.gatewayProviderAccount.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, displayName: true, email: true },
          })
        : [];
      const accountLabels = new Map(
        accounts.map((account) => [
          account.id,
          account.displayName || account.email || account.id,
        ]),
      );
      const clientKeys =
        labels.clientKeys && query.group_by === "client_key"
          ? await tx.gatewayClientKey.findMany({
              where: {
                id: {
                  in: ranked.flatMap((row) => (row.group ? [row.group] : [])),
                },
              },
              select: { id: true, name: true },
            })
          : [];
      const clientKeyLabels = new Map(
        clientKeys.map((key) => [key.id, key.name]),
      );
      const groupLabel = (key: string | null): string => {
        if (key === null)
          return query.group_by === "account" ? "Unassigned" : "Unknown";
        if (query.group_by === "account") return accountLabels.get(key) ?? key;
        if (query.group_by === "client_key")
          return clientKeyLabels.get(key) ?? key;
        return key;
      };
      const bucketRows = (keys: Set<string | null>) => {
        const byBucket = new Map<string, Totals[]>();
        for (const row of groupRows) {
          if (row.kind !== 0 || !keys.has(row.group)) continue;
          const bucket = row.bucket!.toISOString();
          byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row]);
        }
        return new Map(
          [...byBucket].map(([bucket, list]) => [bucket, combine(list)]),
        );
      };
      const groups: GatewayUsageGroup[] = ranked.map((row) => ({
        key: row.group,
        label: groupLabel(row.group),
        other: false,
        ...metrics(row),
        series: series(bucketRows(new Set([row.group]))),
      }));
      if (rest.length) {
        groups.push({
          key: null,
          label: `${rest.length} more`,
          other: true,
          ...metrics(combine(rest)),
          series: series(bucketRows(new Set(rest.map((row) => row.group)))),
        });
      }

      return {
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        interval: query.interval,
        summary: metrics(rows.find((row) => row.kind === 7)),
        series: series(
          new Map(
            rows
              .filter((row) => row.kind === 3)
              .map((row) => [row.bucket!.toISOString(), row]),
          ),
        ),
        accounts: top.map((row) => ({
          ...metrics(row),
          accountId: row.accountId,
          provider: row.provider,
          accountLabel: row.accountId
            ? (accountLabels.get(row.accountId) ?? row.accountId)
            : "Unassigned",
        })),
        accountCount: accountRows.length,
        ...(query.group_by
          ? {
              breakdown: {
                groupBy: query.group_by,
                groupCount: groupTotals.length,
                groups,
              },
            }
          : {}),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 15_000 },
  );
};

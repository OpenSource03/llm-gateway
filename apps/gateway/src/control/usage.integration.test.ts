import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ControlVariables } from "../middleware/control-principal";
import { requireControlScope } from "../middleware/control-auth";
import { usageQuery } from "./usage-query";

const database = process.env.GATEWAY_TEST_DATABASE_URL;
test(
  "usage analytics aggregates all metadata, isolates filters, excludes reservations, and preserves large counts",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/llm_gateway_test");
    process.env.GATEWAY_DATABASE_URL = database;
    const { getLlmGatewayPrisma, closeLlmGatewayDatabase } =
      await import("../core/db");
    const { getGatewayUsage } = await import("./usage.service");
    const prisma = getLlmGatewayPrisma();
    const client = crypto.randomUUID(),
      account = crypto.randomUUID(),
      other = crypto.randomUUID();
    const from = "2026-08-01T00:00:00Z",
      to = "2026-08-04T00:00:00Z";
    const query = usageQuery.parse({ from, to, client_key_id: client });
    const common = {
      clientKeyId: client,
      accountId: account,
      provider: "ANTHROPIC",
      publicModelId: "synthetic/usage",
      startedAt: new Date(from),
      outcome: "success",
      inputTokens: 10n,
      cachedInputTokens: 5n,
      outputTokens: 2n,
      latencyMs: 100,
    };
    try {
      await prisma.gatewayProviderAccount.create({
        data: {
          id: account,
          provider: "ANTHROPIC",
          identityKey: account,
          externalAccountId: account,
          displayName: "Private fixture label",
          email: "fixture@example.invalid",
        },
      });
      await prisma.gatewayRequestLog.createMany({
        data: [
          ...Array.from({ length: 125 }, () => common),
          {
            ...common,
            accountId: other,
            startedAt: new Date("2026-08-03T00:00:00Z"),
            inputTokens: 9007199254740993n,
          },
          {
            ...common,
            outcome: "stream_error",
            inputTokens: 5000n,
            outputTokens: 3000n,
          },
          {
            ...common,
            outcome: "started",
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            latencyMs: null,
          },
          {
            ...common,
            outcome: "internal_error",
            accountId: null,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
          },
          { ...common, startedAt: new Date(to) },
          {
            ...common,
            clientKeyId: crypto.randomUUID(),
            publicModelId: client,
          },
        ],
      });
      const report = await getGatewayUsage(query);
      assert.equal(report.summary.requestCount, 129);
      assert.equal(report.summary.successCount, 126);
      assert.equal(report.summary.errorCount, 2);
      assert.equal(report.summary.pendingCount, 1);
      assert.equal(report.summary.unknownUsageCount, 3);
      assert.equal(
        report.summary.totalTokens,
        (125n * 17n + 9007199254740993n + 7n).toString(),
      );
      assert.equal(report.summary.reservedTokens, "8005");
      assert.equal(report.summary.averageLatencyMs, 100);
      assert.equal(report.series.length, 3);
      assert.equal(report.series[1]!.totalTokens, "0");
      assert.equal(report.series[1]!.requestCount, 0);
      assert.equal(report.accounts.length, 3);
      assert.equal(
        report.accounts.find((row) => row.accountId === account)!.accountLabel,
        account,
      );
      assert.equal(
        (await getGatewayUsage(query, true)).accounts.find(
          (row) => row.accountId === account,
        )!.accountLabel,
        "Private fixture label",
      );
      assert.equal(report.accounts[0]!.accountId, other);
      assert.equal(
        report.accounts.find((row) => row.accountId === null)!.accountLabel,
        "Unassigned",
      );
      assert.equal(
        (await getGatewayUsage({ ...query, account_id: account })).summary
          .totalTokens,
        "2125",
      );
      assert.equal(
        (await getGatewayUsage({ ...query, provider: "OPENAI_CODEX" })).summary
          .requestCount,
        0,
      );
      assert.equal(
        (await getGatewayUsage({ ...query, model: "' OR 1=1 --" })).summary
          .requestCount,
        0,
      );
      const hourly = await getGatewayUsage(
        usageQuery.parse({
          from: "2026-08-01T00:30:00Z",
          to: "2026-08-01T02:00:00Z",
          interval: "hour",
          client_key_id: client,
        }),
      );
      assert.equal(hourly.series.length, 2);
      assert.equal(hourly.series[0]!.bucket, "2026-08-01T00:00:00.000Z");
      assert.equal(hourly.summary.requestCount, 0);
    } finally {
      await prisma.gatewayRequestLog.deleteMany({
        where: { OR: [{ clientKeyId: client }, { publicModelId: client }] },
      });
      await prisma.gatewayProviderAccount.deleteMany({
        where: { id: account },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

test("analytics inherits requests:read and denies other scopes and writes", async () => {
  for (const [scopes, method, expected] of [
    [[], "GET", 403],
    [["accounts:read"], "GET", 403],
    [["requests:read"], "GET", 200],
    [["requests:read"], "POST", 403],
  ] as const) {
    const app = new Hono<{ Variables: ControlVariables }>();
    app.use("*", async (c, next) => {
      c.set("controlPrincipal", {
        credentialId: "fixture",
        credentialName: "fixture",
        scopes: new Set(scopes),
        actor: { id: "fixture", email: null, name: null },
        canDelegateActors: false,
        clientAddress: null,
      });
      await next();
    });
    app.use("*", requireControlScope);
    app.onError((error, c) =>
      c.json(
        { error: "denied" },
        "status" in error ? (error.status as 403) : 500,
      ),
    );
    app.all("/admin/v1/requests/usage", (c) => c.json({ success: true }));
    assert.equal(
      (await app.request("/admin/v1/requests/usage", { method })).status,
      expected,
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "header quota compaction cannot crowd scoped poll windows out of routing",
  { skip: !testDatabaseUrl },
  async () => {
    const parsed = new URL(testDatabaseUrl!);

    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("/llm_gateway_test")
    ) {
      throw new Error(
        "Test requires the disposable localhost gateway database",
      );
    }
    Object.assign(process.env, {
      NODE_ENV: "test",
      GATEWAY_DATABASE_URL: testDatabaseUrl,
      GATEWAY_KEY_WRAPPER: "azure-key-vault",
      GATEWAY_AZURE_KEY_VAULT_KEY_ID:
        "https://test-vault.vault.azure.net/keys/gateway/version-1",
      GATEWAY_SESSION_HMAC_SECRET:
        "test-only-gateway-hmac-secret-32-bytes-long",
    });
    const marker = `quota-compaction-${crypto.randomUUID()}`;
    const [
      { closeLlmGatewayDatabase, getLlmGatewayPrisma },
      { saveQuotaSnapshot },
      dataPlane,
    ] = await Promise.all([
      import("./db"),
      import("../control/accounts.service"),
      import("./data-plane.service"),
    ]);
    const prisma = getLlmGatewayPrisma();
    const account = await prisma.gatewayProviderAccount.create({
      data: {
        provider: "ANTHROPIC",
        identityKey: marker,
        externalAccountId: marker,
      },
    });
    const model = await prisma.gatewayModel.create({
      data: {
        provider: "ANTHROPIC",
        upstreamModelId: marker,
        publicModelId: `anthropic/${marker}`,
        displayName: marker,
        capabilities: {},
        catalogSource: "test",
      },
    });

    try {
      await saveQuotaSnapshot(account.id, {
        provider: "anthropic",
        fetchedAt: Date.now(),
        windows: [
          {
            id: "weekly:scoped",
            label: "Scoped weekly",
            meterKey: "shared_provider_pool",
            usedFraction: 1,
            status: "exhausted",
            scope: marker,
          },
        ],
      });
      for (let index = 0; index < 20; index += 1) {
        await dataPlane.persistGatewayHeaderQuota(account.id, model.id, {
          provider: "anthropic",
          fetchedAt: Date.now() + index,
          windows: [
            {
              id: "five_hour",
              label: "5 hours",
              usedFraction: index / 100,
              status: "ok",
            },
            {
              id: "seven_day",
              label: "7 days",
              usedFraction: index / 100,
              status: "ok",
            },
          ],
        });
      }
      const rows = await prisma.gatewayQuotaSnapshot.findMany({
        where: { accountId: account.id },
        orderBy: [{ source: "asc" }, { windowKey: "asc" }],
      });

      assert.equal(rows.length, 3);
      assert.equal(
        rows.some(
          (row) =>
            row.source === "POLL" &&
            row.modelId === model.id &&
            row.meterKey === "shared_provider_pool" &&
            row.windowKey === "weekly:scoped" &&
            row.utilizationBps === 10_000,
        ),
        true,
      );
      assert.deepEqual(
        rows
          .filter((row) => row.source === "RESPONSE_HEADER")
          .map((row) => row.windowKey)
          .sort(),
        ["five_hour", "seven_day"],
      );

      const newerObservedAt = Date.now() + 20_000;

      await dataPlane.persistGatewayHeaderQuota(account.id, model.id, {
        provider: "anthropic",
        fetchedAt: newerObservedAt,
        windows: [
          {
            id: "five_hour",
            label: "5 hours",
            usedFraction: 1,
            status: "exhausted",
          },
        ],
      });
      // Simulate a slower, older request completing persistence after the
      // newer exhausted observation has already committed.
      await dataPlane.persistGatewayHeaderQuota(account.id, model.id, {
        provider: "anthropic",
        fetchedAt: newerObservedAt - 10_000,
        windows: [
          {
            id: "five_hour",
            label: "5 hours",
            usedFraction: 0.1,
            status: "ok",
          },
        ],
      });
      const retained = await prisma.gatewayQuotaSnapshot.findFirstOrThrow({
        where: {
          accountId: account.id,
          source: "RESPONSE_HEADER",
          windowKey: "five_hour",
        },
      });

      assert.equal(retained.utilizationBps, 10_000);
      assert.equal(retained.limit, null);
      assert.equal(retained.observedAt.getTime(), newerObservedAt);
    } finally {
      await prisma.gatewayQuotaSnapshot.deleteMany({
        where: { accountId: account.id },
      });
      await prisma.gatewayModel.delete({ where: { id: model.id } });
      await prisma.gatewayProviderAccount.delete({
        where: { id: account.id },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";

import {
  accountUsageWindowStart,
  reconcileAccountUsageReservation,
  reserveAccountDailyCapacity,
  routingPoolAccountUsageScopeId,
  routingPoolUsageScopePrefix,
  strictestAccountCap,
} from "./account-usage";

test("rolling account usage includes the complete partial boundary hour", () => {
  const now = new Date("2026-08-12T17:43:29.000Z");

  assert.equal(
    accountUsageWindowStart(now).toISOString(),
    "2026-08-11T17:00:00.000Z",
  );
});

test("member and account limits use the stricter non-null cap", () => {
  assert.equal(strictestAccountCap(null, null), null);
  assert.equal(strictestAccountCap(90n, null), 90n);
  assert.equal(strictestAccountCap(null, 80n), 80n);
  assert.equal(strictestAccountCap(90n, 80n), 80n);
  assert.equal(strictestAccountCap(70n, 80n), 70n);
});

test("routing-pool usage scopes are deterministic and collision-safe", () => {
  assert.equal(
    routingPoolAccountUsageScopeId("pool", "account"),
    routingPoolAccountUsageScopeId("pool", "account"),
  );
  assert.notEqual(
    routingPoolAccountUsageScopeId("ab", "c"),
    routingPoolAccountUsageScopeId("a", "bc"),
  );
  assert.notEqual(
    routingPoolAccountUsageScopeId("pool-a", "account"),
    routingPoolAccountUsageScopeId("pool-b", "account"),
  );
  assert.ok(
    routingPoolAccountUsageScopeId("pool", "account").startsWith(
      routingPoolUsageScopePrefix("pool"),
    ),
  );
  assert.equal(
    routingPoolAccountUsageScopeId("pool", "account").startsWith(
      routingPoolUsageScopePrefix("pool:"),
    ),
    false,
  );
});

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "parallel account reservations enforce caps and reconcile both scopes once",
  { skip: !testDatabaseUrl },
  async () => {
    const parsed = new URL(testDatabaseUrl!);

    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("/llm_gateway_test")
    ) {
      throw new Error(
        "Integration tests only run against the disposable localhost gateway database",
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

    const marker = `account-usage-${crypto.randomUUID()}`;
    const accountId = `${marker}-account`;
    const routingPoolId = `${marker}-pool`;
    const secondRoutingPoolId = `${marker}-pool-2`;
    const poolAccountScopeId = routingPoolAccountUsageScopeId(
      routingPoolId,
      accountId,
    );
    const secondPoolAccountScopeId = routingPoolAccountUsageScopeId(
      secondRoutingPoolId,
      accountId,
    );
    const sharePoolId = `${marker}-share-pool`;
    const shareAccountA = `${marker}-share-a`;
    const shareAccountB = `${marker}-share-b`;
    const shareScopeA = routingPoolAccountUsageScopeId(
      sharePoolId,
      shareAccountA,
    );
    const shareScopeB = routingPoolAccountUsageScopeId(
      sharePoolId,
      shareAccountB,
    );
    const modelId = `${marker}-model`;
    const { closeLlmGatewayDatabase, getLlmGatewayPrisma } =
      await import("./db");
    const prisma = getLlmGatewayPrisma();

    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          reserveAccountDailyCapacity({
            accountId,
            routingPoolId,
            modelId,
            accountCaps: {
              requests: 1,
              inputTokens: 100n,
              outputTokens: 50n,
            },
            memberCaps: {
              requests: null,
              inputTokens: null,
              outputTokens: null,
            },
            maxTrafficShareBps: null,
            estimatedInputTokens: 80,
            requestedOutputTokens: 40,
            retry: false,
          }),
        ),
      );
      const fulfilled = attempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof reserveAccountDailyCapacity>>
        > => attempt.status === "fulfilled",
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );

      assert.equal(
        fulfilled.length,
        1,
        rejected
          .map(({ reason }) =>
            reason instanceof Error
              ? `${reason.name}: ${reason.message}`
              : String(reason),
          )
          .join("\n"),
      );
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]!.reason?.code, "ACCOUNT_DAILY_CAP");

      await reconcileAccountUsageReservation(fulfilled[0]!.value, {
        inputTokens: 70,
        outputTokens: 20,
        cachedInputTokens: 5,
      });
      await reconcileAccountUsageReservation(fulfilled[0]!.value, {
        inputTokens: 70,
        outputTokens: 20,
        cachedInputTokens: 5,
      });
      const firstRows = await prisma.gatewayUsageBucket.findMany({
        where: {
          scopeId: { in: [accountId, poolAccountScopeId] },
          modelId,
        },
        orderBy: { scopeType: "asc" },
      });

      assert.equal(firstRows.length, 2);
      for (const row of firstRows) {
        assert.equal(row.requestCount, 1);
        assert.equal(row.errorCount, 0);
        assert.equal(row.retryCount, 0);
        assert.equal(row.inputTokens, 75n);
        assert.equal(row.outputTokens, 20n);
        assert.equal(row.cachedInputTokens, 5n);
      }

      const retry = await reserveAccountDailyCapacity({
        accountId,
        routingPoolId,
        modelId,
        accountCaps: {
          requests: null,
          inputTokens: null,
          outputTokens: null,
        },
        memberCaps: {
          requests: null,
          inputTokens: null,
          outputTokens: null,
        },
        maxTrafficShareBps: null,
        estimatedInputTokens: 60,
        requestedOutputTokens: 30,
        retry: true,
      });

      await reconcileAccountUsageReservation(retry, {
        inputTokens: 60,
        outputTokens: 7,
        error: true,
      });
      const finalRows = await prisma.gatewayUsageBucket.findMany({
        where: {
          scopeId: { in: [accountId, poolAccountScopeId] },
          modelId,
        },
      });

      assert.equal(finalRows.length, 2);
      for (const row of finalRows) {
        assert.equal(row.requestCount, 2);
        assert.equal(row.errorCount, 1);
        assert.equal(row.retryCount, 1);
        assert.equal(row.inputTokens, 135n);
        assert.equal(row.outputTokens, 27n);
        assert.equal(row.cachedInputTokens, 5n);
      }

      const secondPoolReservation = await reserveAccountDailyCapacity({
        accountId,
        routingPoolId: secondRoutingPoolId,
        modelId,
        accountCaps: {
          requests: null,
          inputTokens: null,
          outputTokens: null,
        },
        memberCaps: {
          requests: 1,
          inputTokens: 20n,
          outputTokens: 10n,
        },
        maxTrafficShareBps: null,
        estimatedInputTokens: 11,
        requestedOutputTokens: 9,
        retry: false,
      });

      await reconcileAccountUsageReservation(secondPoolReservation, {
        inputTokens: 11,
        outputTokens: 9,
      });
      await assert.rejects(
        reserveAccountDailyCapacity({
          accountId,
          routingPoolId: secondRoutingPoolId,
          modelId,
          accountCaps: {
            requests: null,
            inputTokens: null,
            outputTokens: null,
          },
          memberCaps: {
            requests: 1,
            inputTokens: 20n,
            outputTokens: 10n,
          },
          maxTrafficShareBps: null,
          estimatedInputTokens: 1,
          requestedOutputTokens: 1,
          retry: false,
        }),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ROUTING_MEMBER_DAILY_CAP",
      );
      const secondPoolRow = await prisma.gatewayUsageBucket.findUniqueOrThrow({
        where: {
          bucketStart_scopeType_scopeId_modelId: {
            bucketStart: secondPoolReservation.bucketStart,
            scopeType: "ROUTING_POOL",
            scopeId: secondPoolAccountScopeId,
            modelId,
          },
        },
      });

      assert.equal(secondPoolRow.requestCount, 1);
      assert.equal(secondPoolRow.inputTokens, 11n);
      assert.equal(secondPoolRow.outputTokens, 9n);

      const unlimitedCaps = {
        requests: null,
        inputTokens: null,
        outputTokens: null,
      };

      // Seed an exact 50/50 split, then race two requests for the same capped
      // member. The pool/account advisory locks allow one bounded quantum to
      // cross the equality boundary and force the waiter to observe/reject.
      await reserveAccountDailyCapacity({
        accountId: shareAccountA,
        routingPoolId: sharePoolId,
        modelId,
        accountCaps: unlimitedCaps,
        memberCaps: unlimitedCaps,
        maxTrafficShareBps: null,
        estimatedInputTokens: 1,
        requestedOutputTokens: 1,
        retry: false,
      });
      await reserveAccountDailyCapacity({
        accountId: shareAccountB,
        routingPoolId: sharePoolId,
        modelId,
        accountCaps: unlimitedCaps,
        memberCaps: unlimitedCaps,
        maxTrafficShareBps: null,
        estimatedInputTokens: 1,
        requestedOutputTokens: 1,
        retry: false,
      });
      const shareAttempts = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          reserveAccountDailyCapacity({
            accountId: shareAccountA,
            routingPoolId: sharePoolId,
            modelId,
            accountCaps: unlimitedCaps,
            memberCaps: unlimitedCaps,
            maxTrafficShareBps: 5_000,
            estimatedInputTokens: 1,
            requestedOutputTokens: 1,
            retry: false,
          }),
        ),
      );

      assert.equal(
        shareAttempts.filter((attempt) => attempt.status === "fulfilled")
          .length,
        1,
      );
      const rejectedShare = shareAttempts.find(
        (attempt) => attempt.status === "rejected",
      );

      assert.equal(rejectedShare?.status, "rejected");
      if (rejectedShare?.status === "rejected") {
        assert.equal(rejectedShare.reason?.code, "TRAFFIC_SHARE_CAP");
      }
    } finally {
      await prisma.gatewayUsageBucket.deleteMany({
        where: {
          scopeId: {
            in: [
              accountId,
              poolAccountScopeId,
              secondPoolAccountScopeId,
              shareAccountA,
              shareAccountB,
              shareScopeA,
              shareScopeB,
            ],
          },
        },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

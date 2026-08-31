import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError } from "../core/errors";

import {
  assertFeasibleTrafficShareCeilings,
  createRoutingMember,
  deleteRoutingMember,
  updateRoutingMember,
} from "./routing.service";

test("traffic-share ceilings allow empty, uncapped, and fully covered pools", () => {
  assert.doesNotThrow(() => assertFeasibleTrafficShareCeilings([]));
  assert.doesNotThrow(() =>
    assertFeasibleTrafficShareCeilings([
      { enabled: true, maxTrafficShareBps: 1_000 },
      { enabled: true, maxTrafficShareBps: null },
    ]),
  );
  assert.doesNotThrow(() =>
    assertFeasibleTrafficShareCeilings([
      { enabled: true, maxTrafficShareBps: 4_000 },
      { enabled: true, maxTrafficShareBps: 6_000 },
      { enabled: false, maxTrafficShareBps: 1 },
    ]),
  );
});

test("traffic-share ceilings reject enabled members that cannot cover all traffic", () => {
  assert.throws(
    () =>
      assertFeasibleTrafficShareCeilings([
        { enabled: true, maxTrafficShareBps: 4_999 },
        { enabled: true, maxTrafficShareBps: 5_000 },
        { enabled: false, maxTrafficShareBps: null },
      ]),
    (error) =>
      error instanceof GatewayError &&
      error.status === 400 &&
      error.code === "INFEASIBLE_TRAFFIC_SHARE_CEILINGS" &&
      error.message.includes("9999 bps"),
  );
});

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "routing member mutations atomically reject infeasible traffic ceilings",
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

    const marker = `routing-ceilings-${crypto.randomUUID()}`;
    const { closeLlmGatewayDatabase, getLlmGatewayPrisma } =
      await import("../core/db");
    const prisma = getLlmGatewayPrisma();
    const accounts = await Promise.all(
      ["one", "two"].map((suffix) =>
        prisma.gatewayProviderAccount.create({
          data: {
            provider: "ANTHROPIC",
            identityKey: `${marker}-${suffix}`,
            externalAccountId: `${marker}-${suffix}`,
          },
        }),
      ),
    );
    const pool = await prisma.gatewayRoutingPool.create({
      data: {
        provider: "ANTHROPIC",
        name: marker,
        policy: "LEAST_UTILIZED",
      },
    });

    try {
      let row = await createRoutingMember(pool.id, {
        accountId: accounts[0]!.id,
        maxTrafficShareBps: null,
      });

      row = await createRoutingMember(pool.id, {
        accountId: accounts[1]!.id,
        maxTrafficShareBps: 4_000,
      });
      const firstMember = row.members.find(
        (member) => member.accountId === accounts[0]!.id,
      )!;
      const secondMember = row.members.find(
        (member) => member.accountId === accounts[1]!.id,
      )!;

      await assert.rejects(
        updateRoutingMember(pool.id, firstMember.id, {
          maxTrafficShareBps: 5_000,
        }),
        (error) =>
          error instanceof GatewayError &&
          error.code === "INFEASIBLE_TRAFFIC_SHARE_CEILINGS",
      );
      const unchanged = await prisma.gatewayRoutingPoolMember.findUniqueOrThrow(
        {
          where: { id: firstMember.id },
        },
      );

      assert.equal(unchanged.maxTrafficShareBps, null);
      await updateRoutingMember(pool.id, firstMember.id, {
        maxTrafficShareBps: 6_000,
      });
      await assert.rejects(
        deleteRoutingMember(pool.id, secondMember.id),
        (error) =>
          error instanceof GatewayError &&
          error.code === "INFEASIBLE_TRAFFIC_SHARE_CEILINGS",
      );
      assert.equal(
        await prisma.gatewayRoutingPoolMember.count({
          where: { routingPoolId: pool.id },
        }),
        2,
      );

      // A disabled account cannot provide residual traffic-share capacity.
      await updateRoutingMember(pool.id, firstMember.id, {
        maxTrafficShareBps: null,
      });
      await updateRoutingMember(pool.id, secondMember.id, {
        maxTrafficShareBps: null,
      });
      await prisma.gatewayProviderAccount.update({
        where: { id: accounts[0]!.id },
        data: { enabled: false },
      });
      await updateRoutingMember(pool.id, firstMember.id, {
        maxTrafficShareBps: 6_000,
      });
      await assert.rejects(
        updateRoutingMember(pool.id, secondMember.id, {
          maxTrafficShareBps: 4_000,
        }),
        (error) =>
          error instanceof GatewayError &&
          error.code === "INFEASIBLE_TRAFFIC_SHARE_CEILINGS",
      );
    } finally {
      await prisma.gatewayRoutingPool.deleteMany({ where: { id: pool.id } });
      await prisma.gatewayProviderAccount.deleteMany({
        where: { id: { in: accounts.map((account) => account.id) } },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

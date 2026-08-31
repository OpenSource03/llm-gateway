import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError } from "../core/errors";

import { resolveGatewayModel, updateGatewayModel } from "./models.service";

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "canonical model IDs cannot be shadowed by an alias",
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
    const marker = `model-alias-${crypto.randomUUID()}`;
    const { closeLlmGatewayDatabase, getLlmGatewayPrisma } =
      await import("../core/db");
    const prisma = getLlmGatewayPrisma();
    const pool = await prisma.gatewayRoutingPool.create({
      data: { provider: "ANTHROPIC", name: marker, policy: "LEAST_UTILIZED" },
    });
    const [first, second] = await Promise.all(
      ["first", "second"].map((suffix) => {
        const upstreamModelId = `claude-${marker}-${suffix}`;

        return prisma.gatewayModel.create({
          data: {
            provider: "ANTHROPIC",
            upstreamModelId,
            publicModelId: `anthropic/${upstreamModelId}`,
            displayName: suffix,
            capabilities: {},
            catalogSource: "test",
            routingPoolId: pool.id,
          },
        });
      }),
    );

    try {
      await assert.rejects(
        updateGatewayModel(first!.id, { alias: second!.publicModelId }),
        (error) =>
          error instanceof GatewayError &&
          error.code === "MODEL_ALIAS_COLLISION",
      );
      await assert.rejects(
        updateGatewayModel(first!.id, { alias: first!.publicModelId }),
        (error) =>
          error instanceof GatewayError &&
          error.code === "MODEL_ALIAS_COLLISION",
      );
      // Simulate a legacy conflicting row and prove canonical resolution wins.
      await prisma.gatewayModelAlias.create({
        data: { modelId: first!.id, alias: second!.publicModelId },
      });
      assert.equal(
        (await resolveGatewayModel(second!.publicModelId)).id,
        second!.id,
      );
      assert.equal(
        (await resolveGatewayModel(`${first!.upstreamModelId}[1m]`)).id,
        first!.id,
      );
    } finally {
      await prisma.gatewayModelAlias.deleteMany({
        where: { modelId: { in: [first!.id, second!.id] } },
      });
      await prisma.gatewayModel.deleteMany({
        where: { id: { in: [first!.id, second!.id] } },
      });
      await prisma.gatewayRoutingPool.delete({ where: { id: pool.id } });
      await closeLlmGatewayDatabase();
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "account transports default direct and enforce an explicit Agent SDK profile",
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
      GATEWAY_SESSION_HMAC_SECRET:
        "test-only-gateway-hmac-secret-32-bytes-long",
      GATEWAY_KEY_WRAPPER: "azure-key-vault",
      GATEWAY_AZURE_KEY_VAULT_KEY_ID:
        "https://test-vault.vault.azure.net/keys/gateway/version-1",
      GATEWAY_ANTHROPIC_AGENT_SDK_URL: "http://127.0.0.1:3456",
      GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: "a".repeat(32),
    });
    const [{ getLlmGatewayPrisma, closeLlmGatewayDatabase }, accountService] =
      await Promise.all([import("../core/db"), import("./accounts.service")]);
    const prisma = getLlmGatewayPrisma();
    const marker = `transport-${crypto.randomUUID()}`;
    const account = await prisma.gatewayProviderAccount.create({
      data: {
        provider: "ANTHROPIC",
        identityKey: marker,
        externalAccountId: marker,
      },
    });

    try {
      assert.equal(account.transportMode, "direct");
      assert.equal(account.transportProfileId, null);
      const linked = await accountService.updateGatewayAccount(account.id, {
        transportMode: "agent-sdk",
        transportProfileId: "work",
      });

      assert.equal(linked.transportMode, "agent-sdk");
      assert.equal(linked.transportProfileId, "work");
      await assert.rejects(
        accountService.updateGatewayAccount(account.id, {
          transportMode: "direct",
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "DIRECT_CREDENTIAL_REQUIRED",
      );
      await assert.rejects(
        prisma.$executeRaw`
          UPDATE "GatewayProviderAccount"
          SET "transportProfileId" = NULL
          WHERE id = ${account.id}
        `,
      );
    } finally {
      await prisma.gatewayProviderAccount.deleteMany({
        where: { id: account.id },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

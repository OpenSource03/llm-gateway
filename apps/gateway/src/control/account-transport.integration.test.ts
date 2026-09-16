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

test(
  "browser-login accounts adopt only their own gateway-managed Agent SDK profile",
  { skip: !testDatabaseUrl },
  async (t) => {
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
    const [
      { getLlmGatewayPrisma, closeLlmGatewayDatabase },
      accountService,
      envelope,
      { AnthropicAgentSdkTransport },
    ] = await Promise.all([
      import("../core/db"),
      import("./accounts.service"),
      import("../core/security/envelope"),
      import("../core/providers/anthropic-agent-sdk"),
    ]);
    const prisma = getLlmGatewayPrisma();

    t.mock.method(
      envelope.AzureKeyVaultKeyWrapper.prototype,
      "wrapKey",
      async function (
        this: InstanceType<typeof envelope.AzureKeyVaultKeyWrapper>,
        key: Uint8Array,
      ) {
        return { keyId: this.keyId, wrappedKey: Uint8Array.from(key) };
      },
    );
    t.mock.method(
      envelope.AzureKeyVaultKeyWrapper.prototype,
      "unwrapKey",
      async (key: Uint8Array) => Uint8Array.from(key),
    );
    let probes = 0;

    t.mock.method(
      AnthropicAgentSdkTransport.prototype,
      "tokenQuota",
      async () => {
        probes++;

        return {
          provider: "anthropic" as const,
          fetchedAt: Date.now(),
          windows: [],
          metadata: { source: "agent-sdk" },
        };
      },
    );
    const marker = `gateway-managed-${crypto.randomUUID()}`;
    const [account, other] = await Promise.all(
      ["own", "other"].map((suffix) =>
        prisma.gatewayProviderAccount.create({
          data: {
            provider: "ANTHROPIC",
            identityKey: `${marker}-${suffix}`,
            externalAccountId: `${marker}-${suffix}`,
          },
        }),
      ),
    );
    const ownProfile = `gw-token-${account.id}`;
    const rejectsWith = (code: string) => (error: unknown) =>
      error instanceof Error && "code" in error && error.code === code;

    try {
      await assert.rejects(
        accountService.updateGatewayAccount(account.id, {
          transportMode: "agent-sdk",
          transportProfileId: ownProfile,
        }),
        rejectsWith("DIRECT_CREDENTIAL_REQUIRED"),
      );
      const encrypted = await envelope.encryptEnvelope(
        {
          secret: {
            kind: "oauth",
            accessToken: `access-${marker}`,
            refreshToken: `refresh-${marker}`,
            expiresAt: Date.now() + 3_600_000,
          },
          identity: { externalAccountId: `${marker}-own` },
        },
        `credential:${account.id}`,
        envelope.getGatewayKeyWrapper(),
      );

      await prisma.gatewayProviderCredential.create({
        data: {
          accountId: account.id,
          ciphertext: Buffer.from(encrypted.ciphertext),
          nonce: Buffer.from(encrypted.nonce),
          authTag: Buffer.from(encrypted.authTag),
          wrappedDataKey: Buffer.from(encrypted.wrappedDataKey),
          keyWrapperId: encrypted.keyWrapperId,
          encryptionAlgorithm: encrypted.encryptionAlgorithm,
          envelopeVersion: encrypted.envelopeVersion,
        },
      });
      await assert.rejects(
        accountService.updateGatewayAccount(account.id, {
          transportMode: "agent-sdk",
          transportProfileId: `gw-token-${other.id}`,
        }),
        rejectsWith("TRANSPORT_PROFILE_INVALID"),
      );
      assert.equal(probes, 0);
      const linked = await accountService.updateGatewayAccount(account.id, {
        transportMode: "agent-sdk",
        transportProfileId: ownProfile,
      });

      assert.equal(linked.authenticationMethod, "oauth");
      assert.equal(linked.transportMode, "agent-sdk");
      assert.equal(linked.transportProfileId, ownProfile);
      assert.equal(linked.inferenceReady, false);
      assert.equal(probes, 1);
      const stored = await prisma.gatewayProviderCredential.findUniqueOrThrow({
        where: { accountId: account.id },
      });

      assert.equal(
        Buffer.from(stored.ciphertext).includes(
          Buffer.from(`refresh-${marker}`),
        ),
        false,
      );
      // The stored credential still allows an explicit return to direct.
      const direct = await accountService.updateGatewayAccount(account.id, {
        transportMode: "direct",
      });

      assert.equal(direct.transportMode, "direct");
      assert.equal(direct.transportProfileId, null);
      assert.equal(direct.inferenceReady, true);
    } finally {
      await prisma.gatewayProviderAccount.deleteMany({
        where: { id: { in: [account.id, other.id] } },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

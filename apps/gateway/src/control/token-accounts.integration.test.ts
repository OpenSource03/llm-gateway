import assert from "node:assert/strict";
import test from "node:test";

const database = process.env.GATEWAY_TEST_DATABASE_URL;
test(
  "token accounts are encrypted, create-only, independently ready and durably probe-bounded",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/llm_gateway_test");
    process.env.GATEWAY_DATABASE_URL = database;
    const { getLlmGatewayPrisma, closeLlmGatewayDatabase } =
      await import("../core/db");
    const { AzureKeyVaultKeyWrapper } =
      await import("../core/security/envelope");
    const { getProviderAdapter } = await import("../core/providers");
    const service = await import("./accounts.service");
    const { refreshTokenAccountQuota, GENERAL_PROBE_MS } =
      await import("./token-quota.service");
    const { persistGatewayHeaderQuota } =
      await import("../core/data-plane/routing");
    const prisma = getLlmGatewayPrisma();
    t.mock.method(
      AzureKeyVaultKeyWrapper.prototype,
      "wrapKey",
      async function (
        this: InstanceType<typeof AzureKeyVaultKeyWrapper>,
        key: Uint8Array,
      ) {
        return { keyId: this.keyId, wrappedKey: Uint8Array.from(key) };
      },
    );
    t.mock.method(
      AzureKeyVaultKeyWrapper.prototype,
      "unwrapKey",
      async (key: Uint8Array) => Uint8Array.from(key),
    );
    const marker = crypto.randomUUID();
    const upstreamId = `claude-haiku-${marker}`;
    t.mock.method(getProviderAdapter("anthropic"), "discover", async () => ({
      models: [
        {
          upstreamId,
          name: "Claude Haiku Synthetic",
          inputModalities: ["text"],
          reasoning: false,
          source: "live",
        },
      ],
    }));
    let probes = 0;
    t.mock.method(globalThis, "fetch", async () => {
      probes++;
      return Response.json(
        {
          type: "message",
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        },
        {
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.2",
            "anthropic-ratelimit-unified-7d-utilization": "0.3",
          },
        },
      );
    });
    const accountIds: string[] = [];
    let poolId: string | undefined;
    try {
      const input = {
        provider: "anthropic" as const,
        token: `synthetic-${marker}`,
        display_name: marker,
        transport: "direct" as const,
      };
      const created = await service.createGatewayTokenAccount(
        { id: "token-test" },
        input,
      );
      accountIds.push(created.id);

      assert.equal(created.authenticationMethod, "oauth-token");
      assert.equal(
        created.inferenceReady,
        true,
        JSON.stringify(
          {
            created,
            probes,
            budget: await prisma.gatewayTokenProbe.findMany({
              where: { accountId: created.id },
            }),
          },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      );
      assert.equal(probes, 1);
      const stored = await prisma.gatewayProviderCredential.findUniqueOrThrow({
        where: { accountId: created.id },
      });
      assert.equal(
        Buffer.from(stored.ciphertext).includes(Buffer.from(input.token)),
        false,
      );
      assert.equal(stored.accessTokenExpiresAt, null);
      const loaded = await service.loadCredential(created.id);
      assert.equal(loaded.secret.kind, "access-token");
      assert.equal(loaded.secret.refreshToken, undefined);
      assert.equal(loaded.secret.expiresAt, null);
      await assert.rejects(
        service.createGatewayTokenAccount({ id: "test" }, input),
        /already has an account/,
      );
      await assert.rejects(
        service.startOAuthAttempt({ id: "test" }, "anthropic", created.id),
        /require a new account/,
      );
      await assert.rejects(
        service.updateGatewayAccount(created.id, {
          transportMode: "agent-sdk",
          transportProfileId: "default",
        }),
        /chosen at creation/,
      );
      await service.refreshGatewayAccount(created.id, {
        refreshCredential: true,
      });
      assert.equal(probes, 1, "idle account receives no periodic probes");
      const model = await prisma.gatewayModel.findUniqueOrThrow({
        where: { publicModelId: `anthropic/${upstreamId}` },
      });
      const pool = await prisma.gatewayRoutingPool.create({
        data: {
          provider: "ANTHROPIC",
          name: marker,
          members: { create: { accountId: created.id } },
        },
      });
      poolId = pool.id;
      await prisma.gatewayModel.update({
        where: { id: model.id },
        data: { routingPoolId: pool.id },
      });
      await Promise.all(
        Array.from({ length: 5 }, () => refreshTokenAccountQuota(created.id)),
      );
      assert.equal(probes, 1, "concurrent refresh cannot bypass budget");
      await prisma.gatewayTokenProbe.updateMany({
        where: { accountId: created.id },
        data: { attemptedAt: new Date(Date.now() - GENERAL_PROBE_MS - 1) },
      });
      await refreshTokenAccountQuota(created.id);
      assert.equal(probes, 1, "fresh traffic observations suppress probe");
      await prisma.gatewayQuotaSnapshot.updateMany({
        where: { accountId: created.id },
        data: { observedAt: new Date(Date.now() - GENERAL_PROBE_MS - 1) },
      });
      await Promise.all(
        Array.from({ length: 5 }, () => refreshTokenAccountQuota(created.id)),
      );
      assert.equal(probes, 2);
      const budget = await prisma.gatewayTokenProbe.findUniqueOrThrow({
        where: { accountId_kind: { accountId: created.id, kind: "general" } },
      });
      assert.equal(budget.attemptCount, 2);
      assert.equal(budget.outputTokensTotal, 2n);
      assert.equal(budget.unknownUsageCount, 0);
      await prisma.gatewayProviderAccount.update({
        where: { id: created.id },
        data: { status: "REAUTH_REQUIRED" },
      });
      const rejected = await service.refreshGatewayAccount(created.id, {
        refreshCredential: true,
      });
      assert.equal(rejected.status, "REAUTH_REQUIRED");
      assert.equal(rejected.inferenceReady, false);
      // Test-only reset permits exercising the remaining quota fixtures.
      await prisma.gatewayProviderAccount.update({
        where: { id: created.id },
        data: { status: "ACTIVE" },
      });
      await persistGatewayHeaderQuota(created.id, model.id, {
        provider: "anthropic",
        fetchedAt: Date.now(),
        windows: [
          {
            id: "seven_day_overage_included",
            label: "Scoped weekly",
            scope: "requested-model",
            status: "exhausted",
            allowed: false,
            usedFraction: 1,
          },
        ],
      });
      await persistGatewayHeaderQuota(created.id, model.id, {
        provider: "anthropic",
        fetchedAt: Date.now() - 1000,
        windows: [
          {
            id: "seven_day_overage_included",
            label: "Scoped weekly",
            scope: "requested-model",
            status: "ok",
            usedFraction: 0,
          },
        ],
      });
      const scoped = await prisma.gatewayQuotaSnapshot.findFirstOrThrow({
        where: {
          accountId: created.id,
          windowKey: "seven_day_overage_included",
        },
      });
      assert.equal(scoped.utilizationBps, 10000);
      t.mock.method(globalThis, "fetch", async () => {
        throw new Error("synthetic timeout");
      });
      const partial = await service.createGatewayTokenAccount(
        { id: "test" },
        { ...input, token: `other-${marker}` },
      );
      accountIds.push(partial.id);
      assert.equal(partial.inferenceReady, false);
      assert.notEqual(partial.healthReason, null);
    } finally {
      await prisma.gatewayProviderAccount.deleteMany({
        where: { id: { in: accountIds } },
      });
      await prisma.gatewayModel.deleteMany({
        where: { upstreamModelId: upstreamId },
      });
      if (poolId)
        await prisma.gatewayRoutingPool.delete({ where: { id: poolId } });
      await closeLlmGatewayDatabase();
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";

const database = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "testing keys are editable and their requests stay out of history and usage",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/llm_gateway_test");
    process.env.GATEWAY_DATABASE_URL = database;
    const [
      { getLlmGatewayPrisma, closeLlmGatewayDatabase },
      keys,
      history,
      usage,
    ] = await Promise.all([
      import("../core/db"),
      import("./client-keys.service"),
      import("./history.service"),
      import("./usage.service"),
    ]);
    const prisma = getLlmGatewayPrisma();
    const marker = `testing-${crypto.randomUUID()}`;
    const model = await prisma.gatewayModel.create({
      data: {
        provider: "ANTHROPIC",
        upstreamModelId: marker,
        publicModelId: `anthropic/${marker}`,
        displayName: marker,
        capabilities: { inputModalities: ["text"], reasoning: false },
        catalogSource: "integration-test",
      },
    });
    const created = await keys.createGatewayClientKey(
      { id: marker },
      {
        name: marker,
        ownerLabel: "Testing mode",
        allowAllModels: false,
        allowedModelIds: [model.publicModelId],
        testing: true,
      },
    );
    try {
      assert.equal(created.testing, true);
      const principal = await keys.authenticateGatewayClientKey(created.key);
      assert.equal(principal.testing, true);

      const startedAt = new Date();
      await prisma.gatewayRequestLog.create({
        data: {
          clientKeyId: created.id,
          publicModelId: model.publicModelId,
          provider: "ANTHROPIC",
          outcome: "success",
          testing: principal.testing,
          inputTokens: 10n,
          outputTokens: 5n,
          startedAt,
          completedAt: startedAt,
        },
      });
      const filters = { page: 1, perPage: 10, clientKeyId: created.id };
      assert.equal((await history.listGatewayRequestHistory(filters)).total, 0);
      const shown = await history.listGatewayRequestHistory({
        ...filters,
        includeTesting: true,
      });
      assert.equal(shown.total, 1);
      assert.equal(shown.rows[0]?.testing, true);
      const range = {
        from: new Date(startedAt.getTime() - 60_000),
        to: new Date(startedAt.getTime() + 60_000),
        interval: "hour" as const,
        provider: undefined,
        client_key_id: created.id,
      };
      assert.equal(
        (await usage.getGatewayUsage(range)).summary.requestCount,
        0,
      );
      assert.equal(
        (await usage.getGatewayUsage({ ...range, include_testing: true }))
          .summary.requestCount,
        1,
      );

      const updated = await keys.updateGatewayClientKey(created.id, {
        name: `${marker}-renamed`,
        testing: false,
        allowAllModels: true,
        allowedModelIds: [],
        maxConcurrency: 2,
        expiresInDays: null,
      });
      assert.equal(updated.name, `${marker}-renamed`);
      assert.equal(updated.testing, false);
      assert.equal(updated.allowAllModels, true);
      assert.deepEqual(updated.allowedModelIds, []);
      assert.equal(updated.maxConcurrency, 2);
      assert.equal(updated.expiresAt, null);
      // The secret never changes on edit.
      assert.equal(
        (await keys.authenticateGatewayClientKey(created.key)).id,
        created.id,
      );
      await assert.rejects(
        keys.updateGatewayClientKey(created.id, {
          allowAllModels: false,
          allowedModelIds: [],
        }),
        /at least one model/,
      );
      await keys.revokeGatewayClientKey(created.id);
      await assert.rejects(
        keys.updateGatewayClientKey(created.id, { name: "x" }),
        /cannot be edited/,
      );
    } finally {
      await prisma.gatewayRequestLog.deleteMany({
        where: { clientKeyId: created.id },
      });
      await prisma.gatewayClientKey.deleteMany({ where: { id: created.id } });
      await prisma.gatewayModel.deleteMany({ where: { id: model.id } });
      await closeLlmGatewayDatabase();
    }
  },
);

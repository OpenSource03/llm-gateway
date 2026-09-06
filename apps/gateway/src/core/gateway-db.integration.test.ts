import type { ControlVariables } from "../middleware/control-principal";

import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

const testDatabaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;

test(
  "dedicated database stores only key hashes and enforces distributed slots",
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

    const marker = `integration-${crypto.randomUUID()}`;
    const [
      { closeLlmGatewayDatabase, getLlmGatewayPrisma },
      keyService,
      leases,
    ] = await Promise.all([
      import("./db"),
      import("../control/client-keys.service"),
      import("./leases"),
    ]);
    const prisma = getLlmGatewayPrisma();
    const controlKeyService = await import("../control/control-keys.service");
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
    let clientKeyId: string | undefined;

    try {
      const created = await keyService.createGatewayClientKey(
        { id: marker },
        {
          name: marker,
          ownerLabel: "Integration test",
          allowAllModels: false,
          allowedModelIds: [model.publicModelId],
          maxConcurrency: 1,
          dailyRequestCap: 1,
          dailyOutputTokenCap: 10n,
        },
      );

      clientKeyId = created.id;

      assert.match(created.key, /^llmgw_dat_[0-9a-f]{64}$/);
      const stored = await prisma.gatewayClientKey.findUniqueOrThrow({
        where: { id: created.id },
      });

      assert.notEqual(stored.keyHash, created.key);

      const { default: dataRoutes } = await import("./data-plane.routes");
      const body = JSON.stringify({
        model: "openai/" + marker,
        stream: true,
        store: false,
        input: Array.from({ length: 12 }, () => ({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a".repeat(1024 * 1024) }],
        })),
      });
      const large = await dataRoutes.request("/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + created.key },
        body,
      });
      assert.equal(large.status, 404);
      assert.equal((await large.json()).error.code, "MODEL_NOT_FOUND");
      // Parsing reached model resolution without dispatching any provider
      // request. Oversized chunked bodies must fail promptly after auth.
      let cancelled = false;
      let rejectionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const oversized = await Promise.race([
          dataRoutes.request("/v1/responses", {
            method: "POST",
            headers: { authorization: "Bearer " + created.key },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(33 * 1024 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            duplex: "half",
          } as RequestInit & { duplex: "half" }),
          new Promise<never>((_, reject) => {
            rejectionTimer = setTimeout(
              () => reject(new Error("Oversized body rejection hung")),
              2_000,
            );
          }),
        ]);
        assert.equal(oversized.status, 413);
        assert.equal((await oversized.json()).error.code, "REQUEST_TOO_LARGE");
        assert.equal(cancelled, true);
      } finally {
        clearTimeout(rejectionTimer);
      }
      assert.equal(
        JSON.stringify(stored, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ).includes(created.key),
        false,
      );

      const { default: managementRoutes } = await import("../control/routes");
      const routeApp = new Hono<{ Variables: ControlVariables }>();

      routeApp.use("*", async (c, next) => {
        c.set("controlPrincipal", {
          credentialId: marker,
          credentialName: "integration-test",
          scopes: new Set(),
          canDelegateActors: false,
          clientAddress: null,
          actor: {
            id: marker,
            email: "gateway-test@example.invalid",
            name: "Gateway integration test",
          },
        });
        await next();
      });
      routeApp.route("/", managementRoutes);

      const createResponse = await routeApp.request("/client-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${marker}-route`,
          owner_label: "Route integration test",
          allow_all_models: false,
          allowed_model_ids: [model.publicModelId],
        }),
      });

      assert.equal(createResponse.status, 201);
      assert.equal(
        createResponse.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      assert.equal(createResponse.headers.get("pragma"), "no-cache");
      assert.equal(createResponse.headers.get("expires"), "0");
      assert.match(
        ((await createResponse.json()) as { data: { key: string } }).data.key,
        /^llmgw_dat_[0-9a-f]{64}$/,
      );

      const readControlKey = await controlKeyService.createControlKey(marker, {
        name: `${marker}-read-control`,
        owner_label: "Read-only integration test",
        scopes: ["accounts:read"],
        allowed_cidrs: [],
        can_delegate_actors: false,
        expires_in_days: null,
      });
      const delegatedControlKey = await controlKeyService.createControlKey(
        marker,
        {
          name: `${marker}-delegated-control`,
          owner_label: "Delegated integration test",
          scopes: ["client-keys:write", "audit:read"],
          allowed_cidrs: [],
          can_delegate_actors: true,
          expires_in_days: null,
        },
      );
      const cidrControlKey = await controlKeyService.createControlKey(marker, {
        name: `${marker}-cidr-control`,
        owner_label: "CIDR integration test",
        scopes: ["accounts:read"],
        allowed_cidrs: ["127.0.0.1/32"],
        can_delegate_actors: false,
        expires_in_days: null,
      });

      assert.equal(
        (
          await controlKeyService.authenticateControlKey(
            cidrControlKey.key,
            "ip:127.0.0.1",
          )
        ).id,
        cidrControlKey.id,
      );
      await assert.rejects(
        controlKeyService.authenticateControlKey(
          cidrControlKey.key,
          "ip:10.0.0.1",
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Control key is not allowed from this address",
      );
      const { buildControlApp } = await import("../http/apps");
      const controlApp = buildControlApp();
      const readHeaders = { authorization: `Bearer ${readControlKey.key}` };

      assert.equal(
        (await controlApp.request("/admin/v1/status", { headers: readHeaders }))
          .status,
        200,
      );
      assert.equal(
        (await controlApp.request("/admin/v1/models", { headers: readHeaders }))
          .status,
        403,
      );
      assert.equal(
        (
          await controlApp.request("/admin/v1/status", {
            headers: {
              ...readHeaders,
              "x-llm-gateway-actor-id": "spoofed-actor",
            },
          })
        ).status,
        403,
      );

      const delegatedActorId = `${marker}-actor`;
      const controlCreateResponse = await controlApp.request(
        "/admin/v1/client-keys",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${delegatedControlKey.key}`,
            "content-type": "application/json",
            "x-llm-gateway-actor-id": delegatedActorId,
            "x-llm-gateway-actor-email": "actor@example.invalid",
          },
          body: JSON.stringify({
            name: `${marker}-control-route`,
            owner_label: "Control route integration test",
            allow_all_models: false,
            allowed_model_ids: [model.publicModelId],
          }),
        },
      );

      assert.equal(controlCreateResponse.status, 201);
      assert.match(
        ((await controlCreateResponse.json()) as { data: { key: string } }).data
          .key,
        /^llmgw_dat_[0-9a-f]{64}$/,
      );
      const audit = await prisma.gatewayControlAuditLog.findFirstOrThrow({
        where: {
          actorId: delegatedActorId,
          action: "llm-gateway.client-key.create",
        },
      });

      assert.equal(audit.actorEmail, "actor@example.invalid");
      assert.equal(audit.controlCredentialId, delegatedControlKey.id);
      const storedControl = await prisma.gatewayControlKey.findUniqueOrThrow({
        where: { id: delegatedControlKey.id },
      });

      assert.equal(
        JSON.stringify(storedControl).includes(delegatedControlKey.key),
        false,
      );
      const controlRevocations = await Promise.allSettled([
        controlKeyService.revokeControlKey(readControlKey.id),
        controlKeyService.revokeControlKey(delegatedControlKey.id),
        controlKeyService.revokeControlKey(cidrControlKey.id),
      ]);

      assert.equal(
        controlRevocations.filter(({ status }) => status === "fulfilled")
          .length,
        2,
      );
      const preservedLastKey = controlRevocations.find(
        ({ status }) => status === "rejected",
      );

      assert.equal(preservedLastKey?.status, "rejected");
      if (preservedLastKey?.status === "rejected") {
        assert.equal(preservedLastKey.reason?.code, "LAST_CONTROL_KEY");
      }

      const principal = await keyService.authenticateGatewayClientKey(
        created.key,
      );

      assert.deepEqual([...principal.allowedModelIds], [model.publicModelId]);

      // Independent unlimited requests must not be rejected by PostgreSQL
      // serialization conflicts between unrelated lease keys.
      const parallelLeases = await Promise.all(
        Array.from({ length: 30 }, () =>
          leases.tryAcquireConcurrencyLease({
            kind: "CLIENT_CONCURRENCY",
            resourceId: created.id,
            maxConcurrency: null,
            ttlMs: 30_000,
          }),
        ),
      );
      try {
        assert.equal(
          parallelLeases.filter(Boolean).length,
          30,
          "unlimited concurrent requests must all acquire independent leases",
        );
      } finally {
        await leases.releaseLeases(parallelLeases);
      }

      const first = await leases.tryAcquireConcurrencyLease({
        kind: "CLIENT_CONCURRENCY",
        resourceId: created.id,
        maxConcurrency: 1,
        ttlMs: 30_000,
      });

      assert.ok(first);
      assert.equal(
        await leases.tryAcquireConcurrencyLease({
          kind: "CLIENT_CONCURRENCY",
          resourceId: created.id,
          maxConcurrency: 1,
          ttlMs: 30_000,
        }),
        null,
      );
      await leases.releaseLease(first);
      const reclaimed = await leases.tryAcquireConcurrencyLease({
        kind: "CLIENT_CONCURRENCY",
        resourceId: created.id,
        maxConcurrency: 1,
        ttlMs: 30_000,
      });

      assert.ok(reclaimed);
      await leases.releaseLease(reclaimed);

      const contenders = await Promise.all(
        Array.from({ length: 30 }, () =>
          leases.tryAcquireConcurrencyLease({
            kind: "CLIENT_CONCURRENCY",
            resourceId: created.id,
            maxConcurrency: 1,
            ttlMs: 30_000,
          }),
        ),
      );
      try {
        assert.equal(contenders.filter(Boolean).length, 1);
        const winner = contenders.find((lease) => lease !== null)!;
        // Reclaim an expired row under concurrent callers; the old owner
        // must not be able to heartbeat or release the replacement.
        await prisma.gatewayLease.update({
          where: { leaseKey: winner.leaseKey },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        const replacements = await Promise.all(
          Array.from({ length: 30 }, () =>
            leases.tryAcquireConcurrencyLease({
              kind: "CLIENT_CONCURRENCY",
              resourceId: created.id,
              maxConcurrency: 1,
              ttlMs: 30_000,
            }),
          ),
        );
        try {
          assert.equal(replacements.filter(Boolean).length, 1);
          const replacement = replacements.find((lease) => lease !== null)!;
          assert.notEqual(replacement.ownerId, winner.ownerId);
          assert.equal(await leases.heartbeatLease(winner, 30_000), false);
          await leases.releaseLease(winner);
          assert.equal(await leases.heartbeatLease(replacement, 30_000), true);
        } finally {
          await leases.releaseLeases(replacements);
        }
      } finally {
        await leases.releaseLeases(contenders);
      }

      const reservations = await Promise.allSettled([
        keyService.reserveClientDailyCapacity(principal, {
          modelId: model.id,
          estimatedInputTokens: 1,
          requestedOutputTokens: 10,
        }),
        keyService.reserveClientDailyCapacity(principal, {
          modelId: model.id,
          estimatedInputTokens: 1,
          requestedOutputTokens: 10,
        }),
      ]);
      const accepted = reservations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      assert.equal(accepted.length, 1, "daily reservation must be atomic");
      assert.equal(
        reservations.filter((result) => result.status === "rejected").length,
        1,
      );
      const observedUsage = {
        inputTokens: 2,
        outputTokens: 3,
        cachedInputTokens: 4,
        error: true,
      };

      // Stream cancellation and cleanup paths can converge concurrently. Both
      // callbacks (and a later duplicate) must apply one terminal delta total.
      await Promise.all([
        keyService.reconcileClientUsageReservation(accepted[0]!, observedUsage),
        keyService.reconcileClientUsageReservation(accepted[0]!, observedUsage),
      ]);
      await keyService.reconcileClientUsageReservation(
        accepted[0]!,
        observedUsage,
      );
      const usage = await prisma.gatewayUsageBucket.findUniqueOrThrow({
        where: {
          bucketStart_scopeType_scopeId_modelId: {
            bucketStart: accepted[0]!.bucketStart,
            scopeType: "CLIENT_KEY",
            scopeId: created.id,
            modelId: model.id,
          },
        },
      });

      assert.equal(usage.inputTokens, 6n);
      assert.equal(usage.outputTokens, 3n);
      assert.equal(usage.cachedInputTokens, 4n);
      assert.equal(usage.errorCount, 1);
      assert.equal(usage.requestCount, 1);
      assert.equal(usage.retryCount, 0);

      // A retry consumes another token projection under the same lock without
      // consuming another caller-visible request. Only one parallel retry fits
      // the seven remaining output tokens.
      const retryReservations = await Promise.allSettled([
        keyService.reserveClientRetryCapacity(principal, {
          modelId: model.id,
          estimatedInputTokens: 1,
          requestedOutputTokens: 7,
        }),
        keyService.reserveClientRetryCapacity(principal, {
          modelId: model.id,
          estimatedInputTokens: 1,
          requestedOutputTokens: 7,
        }),
      ]);
      const acceptedRetries = retryReservations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const rejectedRetries = retryReservations.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      assert.equal(acceptedRetries.length, 1, "retry cap must be atomic");
      assert.equal(rejectedRetries.length, 1);
      assert.equal(rejectedRetries[0]!.reason?.code, "CLIENT_DAILY_CAP");
      const retryUsage = {
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: 2,
        error: true,
      };

      await Promise.all([
        keyService.reconcileClientUsageReservation(
          acceptedRetries[0]!,
          retryUsage,
        ),
        keyService.reconcileClientUsageReservation(
          acceptedRetries[0]!,
          retryUsage,
        ),
      ]);
      await keyService.reconcileClientUsageReservation(
        acceptedRetries[0]!,
        retryUsage,
      );
      const usageAfterRetry = await prisma.gatewayUsageBucket.findUniqueOrThrow(
        {
          where: {
            bucketStart_scopeType_scopeId_modelId: {
              bucketStart: acceptedRetries[0]!.bucketStart,
              scopeType: "CLIENT_KEY",
              scopeId: created.id,
              modelId: model.id,
            },
          },
        },
      );

      assert.equal(usageAfterRetry.requestCount, 1);
      assert.equal(usageAfterRetry.retryCount, 1);
      assert.equal(usageAfterRetry.inputTokens, 13n);
      assert.equal(usageAfterRetry.outputTokens, 8n);
      assert.equal(usageAfterRetry.cachedInputTokens, 6n);
      assert.equal(usageAfterRetry.errorCount, 2);
      await assert.rejects(
        keyService.assertClientDailyCapacity(principal, 1),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Client daily request cap reached",
      );

      await keyService.revokeGatewayClientKey(created.id);
      await assert.rejects(
        keyService.authenticateGatewayClientKey(created.key),
        (error: unknown) =>
          error instanceof Error && error.message === "Gateway key revoked",
      );
    } finally {
      await prisma.gatewayLease.deleteMany({
        where: clientKeyId
          ? { resourceId: { startsWith: clientKeyId } }
          : { resourceId: marker },
      });
      await prisma.gatewayUsageBucket.deleteMany({
        where: clientKeyId ? { scopeId: clientKeyId } : { scopeId: marker },
      });
      await prisma.gatewayClientKey.deleteMany({
        where: { name: { startsWith: marker } },
      });
      await prisma.gatewayControlAuditLog.deleteMany({
        where: { actorId: { startsWith: marker } },
      });
      await prisma.gatewayControlKey.deleteMany({
        where: { name: { startsWith: marker } },
      });
      await prisma.gatewayModel.deleteMany({
        where: { publicModelId: `anthropic/${marker}` },
      });
      await closeLlmGatewayDatabase();
    }
  },
);

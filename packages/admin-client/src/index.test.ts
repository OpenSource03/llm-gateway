import assert from "node:assert/strict";
import test from "node:test";

import { GatewayAdminApiError, GatewayAdminClient } from "./index";

test("admin client keeps credentials server-side and forwards delegated actor identity", async () => {
  let captured: Request | undefined;
  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1/",
    apiKey: "llmgw_ctl_secret",
    actor: {
      id: "user-123",
      email: "operator@example.test",
      name: "Operator",
    },
    fetch: async (input, init) => {
      captured = new Request(input, init);

      return Response.json({ success: true, data: [] });
    },
  });

  assert.deepEqual(await client.listAccounts(), []);
  assert.equal(captured?.url, "https://control.example.test/admin/v1/accounts");
  assert.equal(
    captured?.headers.get("authorization"),
    "Bearer llmgw_ctl_secret",
  );
  assert.equal(captured?.headers.get("x-llm-gateway-actor-id"), "user-123");
  assert.equal(
    captured?.headers.get("x-llm-gateway-actor-email"),
    "operator@example.test",
  );
});

test("admin client exposes bounded public errors", async () => {
  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1",
    apiKey: "llmgw_ctl_secret",
    fetch: async () =>
      Response.json(
        {
          success: false,
          error: { message: "Scope denied", code: "CONTROL_SCOPE_DENIED" },
        },
        { status: 403 },
      ),
  });

  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof GatewayAdminApiError &&
      error.status === 403 &&
      error.code === "CONTROL_SCOPE_DENIED" &&
      error.message === "Scope denied",
  );
});

test("admin client rejects oversized control responses before buffering", async () => {
  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1",
    apiKey: "llmgw_ctl_secret",
    fetch: async () =>
      new Response("too large", {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
  });

  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof GatewayAdminApiError &&
      error.code === "CONTROL_RESPONSE_TOO_LARGE",
  );
});

test("admin client rejects unsafe base URLs and invalid success envelopes", async () => {
  assert.throws(
    () =>
      new GatewayAdminClient({
        baseUrl: "https://user:password@control.example.test/admin/v1",
        apiKey: "llmgw_ctl_secret",
      }),
    /credential-free HTTP\(S\) URL/,
  );
  assert.throws(
    () =>
      new GatewayAdminClient({
        baseUrl: "https://control.example.test/admin/v1?target=elsewhere",
        apiKey: "llmgw_ctl_secret",
      }),
    /credential-free HTTP\(S\) URL/,
  );

  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1",
    apiKey: "llmgw_ctl_secret",
    fetch: async () => Response.json({ success: true }),
  });

  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof GatewayAdminApiError &&
      error.code === "INVALID_CONTROL_RESPONSE",
  );
});

test("admin client exposes external profile discovery and linking", async () => {
  const requests: Request[] = [];
  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1",
    apiKey: "llmgw_ctl_secret",
    fetch: async (input, init) => {
      const request = new Request(input, init);

      requests.push(request);
      if (request.method === "GET") {
        return Response.json({
          success: true,
          data: [{ id: "default", authenticated: true }],
        });
      }

      return Response.json({
        success: true,
        data: {
          id: "account-1",
          provider: "ANTHROPIC",
          transportMode: "agent-sdk",
          transportProfileId: "default",
        },
      });
    },
  });

  assert.equal(
    (await client.listExternalProfiles("anthropic"))[0]?.id,
    "default",
  );
  await client.linkExternalProfile({
    provider: "anthropic",
    transport: "agent-sdk",
    profile_id: "default",
  });
  assert.equal(
    requests[0]?.url,
    "https://control.example.test/admin/v1/accounts/external-profiles?provider=anthropic&transport=agent-sdk",
  );
  assert.deepEqual(await requests[1]?.json(), {
    provider: "anthropic",
    transport: "agent-sdk",
    profile_id: "default",
  });
});

test("admin client keeps provider verification actions on the control plane", async () => {
  let captured: Request | undefined;
  const client = new GatewayAdminClient({
    baseUrl: "https://control.example.test/admin/v1",
    apiKey: "llmgw_ctl_secret",
    fetch: async (input, init) => {
      captured = new Request(input, init);

      return Response.json({
        success: true,
        data: {
          status: "action_required",
          actionUrl:
            "https://accounts.google.com/signin/continue?service=cloudcode",
        },
      });
    },
  });
  const result = await client.verifyAccountAccess(
    "4d940f3d-914c-43b8-82d4-d60abc6c2cb7",
  );

  assert.equal(result.status, "action_required");
  assert.equal(captured?.method, "POST");
  assert.equal(
    captured?.url,
    "https://control.example.test/admin/v1/accounts/4d940f3d-914c-43b8-82d4-d60abc6c2cb7/verify-access",
  );
});

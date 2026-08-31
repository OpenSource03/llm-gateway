import assert from "node:assert/strict";
import test from "node:test";

import dataPlaneRoutes from "./data-plane.routes";

test("model-list authentication errors cannot be cached", async () => {
  const response = await dataPlaneRoutes.request("/v1/models");

  assert.notEqual(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("vary"), "Authorization");
});

test("Codex model-list errors use the Responses error shape", async () => {
  const response = await dataPlaneRoutes.request(
    "/v1/models?client_version=0.150.1",
  );
  const body = (await response.json()) as {
    error?: { type?: string; code?: string };
  };

  assert.equal(response.status, 401);
  assert.equal(body.error?.type, "authentication_error");
  assert.equal(body.error?.code, "GATEWAY_KEY_REQUIRED");
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});

test("Codex Responses authenticates before parsing the body", async () => {
  const response = await dataPlaneRoutes.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  });
  const body = (await response.json()) as {
    error?: { type?: string; code?: string };
  };

  assert.equal(response.status, 401);
  assert.equal(body.error?.type, "authentication_error");
  assert.equal(body.error?.code, "GATEWAY_KEY_REQUIRED");
});

test("Codex standalone search authenticates before parsing the body", async () => {
  const response = await dataPlaneRoutes.request("/v1/alpha/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  });
  const body = (await response.json()) as {
    error?: { type?: string; code?: string };
  };

  assert.equal(response.status, 401);
  assert.equal(body.error?.type, "authentication_error");
  assert.equal(body.error?.code, "GATEWAY_KEY_REQUIRED");
});

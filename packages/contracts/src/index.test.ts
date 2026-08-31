import assert from "node:assert/strict";
import test from "node:test";

import {
  controlOpenApiDocument,
  createControlKeySchema,
  providerIdSchema,
} from "./index";

test("provider ids are extensible but safely bounded", () => {
  assert.equal(providerIdSchema.parse("future-provider"), "future-provider");
  assert.equal(providerIdSchema.safeParse("../provider").success, false);
});

test("control-key contract rejects unknown scopes and fields", () => {
  assert.equal(
    createControlKeySchema.safeParse({
      name: "integration",
      owner_label: "Company dashboard",
      scopes: ["accounts:read"],
      unknown: true,
    }).success,
    false,
  );
});

test("OpenAPI publishes every control-plane resource family", () => {
  for (const path of [
    "/accounts",
    "/models",
    "/routing-pools",
    "/client-keys",
    "/control-keys",
    "/requests",
    "/audit",
  ]) {
    assert.ok(path in controlOpenApiDocument.paths);
  }
});

test("OpenAPI declares every path parameter and shared OAuth body", () => {
  const paths = controlOpenApiDocument.paths as Record<
    string,
    Record<string, { parameters?: Array<{ in: string; name: string }> }>
  >;

  for (const [path, methods] of Object.entries(paths)) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1],
    );

    for (const operation of Object.values(methods)) {
      const declared = new Set(
        operation.parameters
          ?.filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name) ?? [],
      );

      assert.deepEqual(declared, new Set(placeholders), path);
    }
  }

  assert.deepEqual(
    controlOpenApiDocument.paths["/oauth-attempts"].post.requestBody!.content[
      "application/json"
    ].schema,
    { $ref: "#/components/schemas/StartOAuth" },
  );
  assert.equal(
    "x-required-scope" in controlOpenApiDocument.paths["/status"].get,
    false,
  );
});

test("OpenAPI operation ids are stable and unique", () => {
  const operations = Object.values(controlOpenApiDocument.paths).flatMap(
    (methods) => Object.values(methods),
  );
  const ids = operations.map((operation) => operation.operationId);

  assert.ok(ids.every((id) => /^[a-z][A-Za-z0-9]+$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
});

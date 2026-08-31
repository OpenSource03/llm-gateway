import assert from "node:assert/strict";
import test from "node:test";

import { normalizeObjectRootToolInputSchema } from "./object-root-tool-schema";

test("preserves a compatible object schema by value", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };

  assert.deepEqual(normalizeObjectRootToolInputSchema(schema), schema);
});

test("supplies the object root fields required by subscription transports", () => {
  assert.deepEqual(normalizeObjectRootToolInputSchema({}), {
    type: "object",
    properties: {},
  });
  assert.deepEqual(
    normalizeObjectRootToolInputSchema({
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  );
});

test("projects a top-level oneOf into a compatible object shape", () => {
  const normalized = normalizeObjectRootToolInputSchema({
    description: "Open a file by path or numeric identifier",
    oneOf: [
      {
        type: "object",
        properties: {
          target: { type: "string" },
          path: { type: "string" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          target: { type: "number" },
          id: { type: "number" },
        },
        required: ["target"],
        additionalProperties: false,
      },
    ],
  });

  assert.equal(Object.hasOwn(normalized, "oneOf"), false);
  assert.equal(normalized.type, "object");
  assert.equal(
    normalized.description,
    "Open a file by path or numeric identifier",
  );
  assert.deepEqual(normalized.required, ["target"]);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual((normalized.properties as Record<string, unknown>).target, {
    oneOf: [{ type: "string" }, { type: "number" }],
  });
  assert.deepEqual(Object.keys(normalized.properties as object).sort(), [
    "id",
    "path",
    "target",
  ]);
});

test("unions allOf requirements and keeps conflicting constraints nested", () => {
  const normalized = normalizeObjectRootToolInputSchema({
    type: "object",
    properties: { common: { minLength: 1 } },
    required: ["common"],
    allOf: [
      {
        type: "object",
        properties: { common: { maxLength: 20 }, left: { type: "boolean" } },
        required: ["left"],
      },
      {
        type: "object",
        properties: { right: { type: "number" } },
        required: ["right"],
      },
    ],
  });

  assert.equal(Object.hasOwn(normalized, "allOf"), false);
  assert.deepEqual(
    new Set(normalized.required as string[]),
    new Set(["common", "left", "right"]),
  );
  assert.deepEqual((normalized.properties as Record<string, unknown>).common, {
    allOf: [{ minLength: 1 }, { maxLength: 20 }],
  });
});

test("strips Responses-only encrypted annotations without deleting literal names", () => {
  const normalized = normalizeObjectRootToolInputSchema({
    type: "object",
    default: { encrypted: true },
    required: ["encrypted"],
    $defs: { encrypted: { type: "string", encrypted: true } },
    properties: {
      encrypted: { type: "boolean", encrypted: true },
      nested: {
        type: "array",
        items: { type: "string", encrypted: true },
      },
      literal: { const: { encrypted: true } },
    },
  });
  const properties = normalized.properties as Record<
    string,
    Record<string, unknown>
  >;

  assert.deepEqual(normalized.default, { encrypted: true });
  assert.deepEqual(properties.encrypted, { type: "boolean" });
  assert.equal(
    (properties.nested.items as Record<string, unknown>).encrypted,
    undefined,
  );
  assert.deepEqual(properties.literal.const, { encrypted: true });
  assert.deepEqual(normalized.$defs, { encrypted: { type: "string" } });
});

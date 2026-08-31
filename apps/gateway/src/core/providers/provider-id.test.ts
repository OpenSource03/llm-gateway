import assert from "node:assert/strict";
import test from "node:test";

import { fromDbProvider, toDbProvider } from "./provider-id";

test("provider identifiers round-trip across the database boundary", () => {
  for (const provider of [
    "anthropic",
    "openai",
    "xai",
    "future-provider",
  ] as const) {
    assert.equal(fromDbProvider(toDbProvider(provider)), provider);
  }
});

test("provider identifiers reject spellings unsafe for public model ids", () => {
  assert.throws(() => toDbProvider("../provider"), /Invalid provider id/);
  assert.throws(() => fromDbProvider("PROVIDER_NAME"), /Invalid provider id/);
});

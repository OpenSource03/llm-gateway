import assert from "node:assert/strict";
import test from "node:test";
import { usageQuery } from "./usage-query";

test("usage ranges are bounded and reject malformed filters", () => {
  const from = "2026-08-01T00:00:00Z";
  assert.equal(usageQuery.safeParse({ from, to: from }).success, false);
  assert.equal(
    usageQuery.safeParse({ from, to: "2027-01-01T00:00:00Z" }).success,
    false,
  );
  assert.equal(
    usageQuery.safeParse({ from, to: "2026-08-10T00:00:00Z", interval: "hour" })
      .success,
    false,
  );
  assert.equal(usageQuery.safeParse({ from: "not a date" }).success, false);
  assert.equal(
    usageQuery.safeParse({ account_id: "' OR 1=1 --" }).success,
    false,
  );
  const parsed = usageQuery.parse({
    from,
    to: "2026-08-02T00:00:00+02:00",
    interval: "hour",
    provider: "openai-codex",
  });
  assert.equal(parsed.to.toISOString(), "2026-08-01T22:00:00.000Z");
  assert.equal(parsed.provider, "OPENAI-CODEX");
});

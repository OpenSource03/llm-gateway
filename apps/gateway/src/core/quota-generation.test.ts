import assert from "node:assert/strict";
import test from "node:test";

import { withoutSupersededHeaderQuota } from "./quota-generation";

const row = (source: string, observedAt: string, windowKey: string) => ({
  source,
  observedAt: new Date(observedAt),
  windowKey,
});

test("header rows older than the latest poll are superseded", () => {
  const rows = [
    row("RESPONSE_HEADER", "2026-09-25T10:00:00Z", "chat:primary"),
    row("POLL", "2026-09-25T11:00:00Z", "seven_day"),
    row("RESPONSE_HEADER", "2026-09-25T12:00:00Z", "seven_day"),
  ];

  assert.deepEqual(
    withoutSupersededHeaderQuota(rows).map(({ source, windowKey }) => [
      source,
      windowKey,
    ]),
    [
      ["POLL", "seven_day"],
      ["RESPONSE_HEADER", "seven_day"],
    ],
  );
});

test("header rows are kept when no poll exists", () => {
  const rows = [row("RESPONSE_HEADER", "2026-09-25T10:00:00Z", "chat:primary")];

  assert.deepEqual(withoutSupersededHeaderQuota(rows), rows);
});

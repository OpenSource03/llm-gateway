import assert from "node:assert/strict";
import test from "node:test";

import { AuthFailureRateLimiter } from "./auth-failure-rate-limit";

test("auth failure limiter expires fixed windows and clears on success", () => {
  let now = 1_000;
  const limiter = new AuthFailureRateLimiter({
    limit: 2,
    maxKeys: 4,
    windowMs: 100,
    now: () => now,
  });

  limiter.recordFailure("caller");
  assert.equal(limiter.retryAt("caller"), null);
  limiter.recordFailure("caller");
  assert.equal(limiter.retryAt("caller")?.getTime(), 1_100);

  limiter.recordSuccess("caller");
  assert.equal(limiter.retryAt("caller"), null);

  limiter.recordFailure("caller");
  limiter.recordFailure("caller");
  now = 1_100;
  assert.equal(limiter.retryAt("caller"), null);
});

test("auth failure limiter evicts the least recently used key at its hard bound", () => {
  const limiter = new AuthFailureRateLimiter({
    limit: 2,
    maxKeys: 2,
    windowMs: 1_000,
    now: () => 10,
  });

  limiter.recordFailure("oldest");
  limiter.recordFailure("recent");
  assert.equal(limiter.retryAt("oldest"), null); // LRU touch
  limiter.recordFailure("new"); // evicts "recent"

  limiter.recordFailure("recent");
  assert.equal(limiter.retryAt("recent"), null);

  limiter.recordFailure("new");
  assert.equal(limiter.retryAt("new")?.getTime(), 1_010);
});

test("auth failure limiter rejects invalid capacity configuration", () => {
  assert.throws(
    () =>
      new AuthFailureRateLimiter({
        limit: 1,
        maxKeys: 0,
        windowMs: 1,
      }),
    /positive integers/,
  );
});

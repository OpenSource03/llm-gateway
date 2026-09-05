import type { RoutingMemberCandidate } from "./types";

import assert from "node:assert/strict";
import test from "node:test";

import { selectRoutingAccount } from "./engine";

const now = new Date("2026-08-12T12:00:00.000Z");

const member = (
  id: string,
  overrides: Partial<RoutingMemberCandidate> = {},
): RoutingMemberCandidate => ({
  accountId: id,
  provider: "anthropic",
  enabled: true,
  supportsModel: true,
  health: "healthy",
  weight: 1,
  priority: 0,
  maxConcurrency: 3,
  activeConcurrency: 0,
  dailyRequestCap: null,
  dailyInputTokenCap: null,
  dailyOutputTokenCap: null,
  requestsLast24h: 0,
  inputTokensLast24h: 0,
  outputTokensLast24h: 0,
  maxTrafficShareBps: null,
  trafficShareBps: 0,
  maxUsedRatio: 0.95,
  reserveRatio: 0.05,
  quotaObservedAt: now,
  quotaWindows: [
    {
      id: "chat:5h",
      usedRatio: 0.2,
      resetAt: new Date(now.getTime() + 5 * 60 * 60 * 1000),
    },
  ],
  cooldownUntil: null,
  ...overrides,
});

test("quota-balanced chooses the strongest sustainable headroom", () => {
  const result = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("busy", {
        quotaWindows: [
          {
            id: "5h",
            usedRatio: 0.8,
            resetAt: new Date(now.getTime() + 60_000),
          },
        ],
      }),
      member("fresh", {
        quotaWindows: [
          {
            id: "5h",
            usedRatio: 0.1,
            resetAt: new Date(now.getTime() + 60_000),
          },
        ],
      }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "session-a",
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") assert.equal(result.accountId, "fresh");
});

test("fraction-only stored quota remains dimensionless when scoring a prompt", () => {
  const result = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("busy", {
        quotaWindows: [
          {
            id: "5h",
            usedRatio: 0.7,
            limit: null,
            resetAt: new Date(now.getTime() + 60_000),
          },
        ],
      }),
      member("fresh", {
        quotaWindows: [
          {
            id: "5h",
            usedRatio: 0.1,
            limit: null,
            resetAt: new Date(now.getTime() + 60_000),
          },
        ],
      }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "stored-fraction",
    estimatedInputTokens: 8_000,
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") assert.equal(result.accountId, "fresh");
});

test("weighted selection is stable for a session key", () => {
  const input = {
    policy: "weighted_share" as const,
    members: [member("a", { weight: 1 }), member("b", { weight: 4 })],
    now,
    modelId: "anthropic/claude",
    requestKey: "same-session",
  };
  const first = selectRoutingAccount(input);
  const second = selectRoutingAccount(input);

  assert.equal(first.kind, "selected");
  assert.deepEqual(first, second);
});

test("priority failover never crosses an eligible lower priority tier", () => {
  const result = selectRoutingAccount({
    policy: "priority_failover",
    members: [
      member("primary", { priority: 0 }),
      member("backup", { priority: 10 }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "request",
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") assert.equal(result.accountId, "primary");
});

test("new sessions exclude stale quota but an existing sticky session continues", () => {
  const stale = member("stale", {
    quotaObservedAt: new Date(now.getTime() - 16 * 60 * 1000),
  });
  const fresh = member("fresh");
  const newSession = selectRoutingAccount({
    policy: "least_utilized",
    members: [stale, fresh],
    now,
    modelId: "anthropic/claude",
    requestKey: "new",
  });
  const sticky = selectRoutingAccount({
    policy: "least_utilized",
    members: [stale, fresh],
    now,
    modelId: "anthropic/claude",
    requestKey: "old",
    stickyAccountId: "stale",
  });

  assert.equal(newSession.kind, "selected");
  if (newSession.kind === "selected")
    assert.equal(newSession.accountId, "fresh");
  assert.equal(sticky.kind, "selected");
  if (sticky.kind === "selected") {
    assert.equal(sticky.accountId, "stale");
    assert.equal(sticky.sticky, true);
  }
});

test("short sticky quota reset returns hold instead of breaking cache affinity", () => {
  const resetAt = new Date(now.getTime() + 10 * 60 * 1000);
  const result = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("sticky", {
        quotaWindows: [{ id: "5h", usedRatio: 1, resetAt }],
      }),
      member("other"),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "session",
    stickyAccountId: "sticky",
  });

  assert.equal(result.kind, "hold");
  if (result.kind === "hold")
    assert.equal(result.retryAt.toISOString(), resetAt.toISOString());
});

test("long sticky exhaustion migrates to an eligible account", () => {
  const result = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("sticky", {
        quotaWindows: [
          {
            id: "7d",
            usedRatio: 1,
            resetAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        ],
      }),
      member("other"),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "session",
    stickyAccountId: "sticky",
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.accountId, "other");
    assert.equal(result.sticky, false);
  }
});

test("reports the earliest retry time when all accounts are cooling down", () => {
  const soon = new Date(now.getTime() + 30_000);
  const later = new Date(now.getTime() + 60_000);
  const result = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("a", { cooldownUntil: later }),
      member("b", { cooldownUntil: soon }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "request",
  });

  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.equal(result.reason, "quota");
    assert.equal(result.retryAt?.toISOString(), soon.toISOString());
  }
});

test("distinguishes confirmed quota exhaustion from retryable quota state", () => {
  const resetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const exhausted = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("spent", {
        quotaWindows: [{ id: "7d", usedRatio: 1, resetAt }],
      }),
    ],
    now,
    modelId: "openai/gpt-6-astra",
    requestKey: "spent-plan",
  });
  const stale = selectRoutingAccount({
    policy: "quota_balanced",
    members: [
      member("stale", {
        quotaObservedAt: new Date(now.getTime() - 60 * 60 * 1_000),
      }),
    ],
    now,
    modelId: "openai/gpt-6-astra",
    requestKey: "stale-plan",
    quotaMaxAgeMs: 15 * 60 * 1_000,
  });

  assert.equal(exhausted.kind, "unavailable");
  if (exhausted.kind === "unavailable") {
    assert.equal(exhausted.reason, "quota_exhausted");
    assert.equal(exhausted.retryAt?.toISOString(), resetAt.toISOString());
  }
  assert.equal(stale.kind, "unavailable");
  if (stale.kind === "unavailable") assert.equal(stale.reason, "quota");
});

test("traffic-share ceilings use one-request deficit tolerance at an exact share", () => {
  const result = selectRoutingAccount({
    policy: "least_utilized",
    members: [
      member("a", {
        requestsLast24h: 1,
        trafficShareBps: 5_000,
        maxTrafficShareBps: 5_000,
      }),
      member("b", {
        requestsLast24h: 1,
        trafficShareBps: 5_000,
        maxTrafficShareBps: 5_000,
      }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "next-request",
  });

  assert.equal(result.kind, "selected");
});

test("a sticky session migrates after its account exceeds a hard traffic ceiling", () => {
  const result = selectRoutingAccount({
    policy: "least_utilized",
    members: [
      member("sticky", {
        trafficShareBps: 7_000,
        maxTrafficShareBps: 5_000,
      }),
      member("other", {
        trafficShareBps: 3_000,
        maxTrafficShareBps: 5_000,
      }),
    ],
    now,
    modelId: "anthropic/claude",
    requestKey: "sticky-request",
    stickyAccountId: "sticky",
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.accountId, "other");
    assert.equal(result.sticky, false);
  }
});

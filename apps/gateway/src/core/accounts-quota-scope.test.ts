import assert from "node:assert/strict";
import test from "node:test";

import { saveQuotaSnapshot } from "../control/accounts.service";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

test("polled quota attaches only exact upstream and public model scopes", async () => {
  let lookup: { provider: string; scopes: string[] } | undefined;
  let rows:
    | Array<{
        accountId: string;
        modelId: string | null;
        meterKey: string;
        windowKey: string;
      }>
    | undefined;

  await saveQuotaSnapshot(
    "account-1",
    {
      provider: "anthropic",
      fetchedAt: NOW,
      windows: [
        {
          id: "weekly:claude-opus-4-8",
          label: "Opus weekly",
          usedFraction: 0.25,
          status: "ok",
          scope: "claude-opus-4-8",
        },
        {
          id: "weekly:claude-sonnet-4-6",
          label: "Sonnet weekly",
          usedFraction: 0.5,
          status: "ok",
          scope: "anthropic/claude-sonnet-4-6",
        },
        {
          id: "priority:weekly",
          label: "Priority processing",
          usedFraction: 0.1,
          status: "ok",
          scope: "priority-processing",
        },
        {
          id: "five_hour",
          label: "5 hours",
          usedFraction: 0.2,
          status: "ok",
        },
      ],
    },
    {
      findModels: async (input) => {
        lookup = input;

        return [
          {
            id: "model-opus",
            upstreamModelId: "claude-opus-4-8",
            publicModelId: "anthropic/claude-opus-4-8",
          },
          {
            id: "model-sonnet",
            upstreamModelId: "claude-sonnet-4-6",
            publicModelId: "anthropic/claude-sonnet-4-6",
          },
        ];
      },
      replacePollSnapshot: async (accountId, data) => {
        assert.equal(accountId, "account-1");
        rows = data;
      },
    },
  );

  assert.deepEqual(lookup, {
    provider: "ANTHROPIC",
    scopes: [
      "claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
      "priority-processing",
    ],
  });
  assert.deepEqual(
    rows?.map((row) => ({
      windowKey: row.windowKey,
      meterKey: row.meterKey,
      modelId: row.modelId,
    })),
    [
      {
        windowKey: "weekly:claude-opus-4-8",
        meterKey: "claude-opus-4-8",
        modelId: "model-opus",
      },
      {
        windowKey: "weekly:claude-sonnet-4-6",
        meterKey: "anthropic/claude-sonnet-4-6",
        modelId: "model-sonnet",
      },
      { windowKey: "five_hour", meterKey: "chat", modelId: null },
    ],
  );
});

test("empty quota snapshots atomically invalidate the prior poll generation", async () => {
  let lookupCalled = false;
  let replacement: { accountId: string; rows: unknown[] } | undefined;

  await saveQuotaSnapshot(
    "account-1",
    { provider: "anthropic", fetchedAt: NOW, windows: [] },
    {
      findModels: async () => {
        lookupCalled = true;

        return [];
      },
      replacePollSnapshot: async (accountId, rows) => {
        replacement = { accountId, rows };
      },
    },
  );

  assert.equal(lookupCalled, false);
  assert.deepEqual(replacement, { accountId: "account-1", rows: [] });
});

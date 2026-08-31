import assert from "node:assert/strict";
import test from "node:test";

import {
  combinedCachedInputTokens,
  reconciledBillableInputTokens,
  uncachedResponsesInputTokens,
} from "./usage-accounting";

test("billable input includes cache reads and cache creation", () => {
  assert.equal(combinedCachedInputTokens(30, 20), 50);
  assert.equal(
    reconciledBillableInputTokens({
      reservedInputTokens: 1_000n,
      inputTokens: 100,
      cachedInputTokens: 50,
    }),
    150n,
  );
});

test("Responses inclusive input is normalized before shared reconciliation", () => {
  assert.equal(uncachedResponsesInputTokens(150, 50), 100);
  assert.equal(uncachedResponsesInputTokens(40, 50), 0);
  assert.equal(uncachedResponsesInputTokens(undefined, 50), undefined);
  assert.equal(
    reconciledBillableInputTokens({
      reservedInputTokens: 1_000n,
      inputTokens: uncachedResponsesInputTokens(150, 50),
      cachedInputTokens: 50,
    }),
    150n,
  );
});

test("missing ordinary input retains the conservative complete-prompt reservation", () => {
  assert.equal(
    reconciledBillableInputTokens({
      reservedInputTokens: 1_000n,
      cachedInputTokens: 50,
    }),
    1_000n,
  );
  assert.equal(combinedCachedInputTokens(undefined, undefined), undefined);
});

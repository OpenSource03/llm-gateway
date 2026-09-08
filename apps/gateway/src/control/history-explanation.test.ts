import assert from "node:assert/strict";
import test from "node:test";
import { explainRequestHistory } from "./history-explanation";

test("historical stream errors are reservations with an explicit uncertainty boundary", () => {
  const result = explainRequestHistory("stream_error", null);
  assert.equal(result.tokenUsageBasis, "conservative_reservation");
  assert.match(
    result.outcomeExplanation!,
    /cannot be distinguished retrospectively/,
  );
  assert.match(result.tokenUsageExplanation, /not measured consumption/);
});

test("safe explanations distinguish cancellation and provider failures without echoing raw labels", () => {
  assert.match(
    explainRequestHistory("stream_error", "ClientStreamCancelled")
      .outcomeExplanation!,
    /does not establish a provider failure/,
  );
  assert.match(
    explainRequestHistory("stream_error", "UpstreamStreamError")
      .outcomeExplanation!,
    /explicit failure event/,
  );
  assert.ok(
    !JSON.stringify(
      explainRequestHistory("stream_error", "secret-provider-payload"),
    ).includes("secret-provider-payload"),
  );
  assert.equal(
    explainRequestHistory("success", null).tokenUsageBasis,
    "accounted",
  );
});

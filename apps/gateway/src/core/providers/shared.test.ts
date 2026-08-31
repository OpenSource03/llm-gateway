import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROVIDER_MODEL_ID_LENGTH,
  ProviderProtocolError,
  fetchWithTimeout,
  providerModelId,
  readBoundedText,
} from "./shared";

test("provider model selectors reject unsafe or oversized ids", () => {
  assert.equal(providerModelId("gpt-safe"), "gpt-safe");
  assert.equal(providerModelId(" gpt-trimmed"), undefined);
  assert.equal(providerModelId("gpt\ncontrol"), undefined);
  assert.equal(
    providerModelId("x".repeat(MAX_PROVIDER_MODEL_ID_LENGTH + 1)),
    undefined,
  );
});

test("provider timeout remains active while a response body is being read", async () => {
  const captured: { fetchSignal?: AbortSignal } = {};
  let upstreamCancelReason: unknown;
  const fetchImpl = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.fetchSignal = init?.signal as AbortSignal;

    return new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          upstreamCancelReason = reason;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const response = await fetchWithTimeout(
    fetchImpl,
    "https://provider.test/token",
    { method: "GET" },
    25,
  );

  await assert.rejects(
    readBoundedText(response),
    (error) =>
      error instanceof ProviderProtocolError &&
      error.message === "Provider request timed out",
  );
  assert.equal(captured.fetchSignal?.aborted, true);
  assert.equal(upstreamCancelReason, captured.fetchSignal?.reason);
});

test("bounded body rejection cancels the provider stream", async () => {
  let upstreamCancelReason: unknown;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(32));
        },
        cancel(reason) {
          upstreamCancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    ),
  );

  await assert.rejects(readBoundedText(response, 16), /size limit/);
  assert.match(String((upstreamCancelReason as Error)?.message), /size limit/);
});

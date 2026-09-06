import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError } from "./errors";
import { readBoundedRequestBody } from "./read-bounded-body";

test("bounded request reads fragmented bodies without relying on Content-Length", async () => {
  const encoder = new TextEncoder();
  const request = new Request("https://gateway.invalid/messages", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("hel"));
        controller.enqueue(encoder.encode("lo"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  assert.equal(
    new TextDecoder().decode(await readBoundedRequestBody(request, 5)),
    "hello",
  );
});

test("bounded request cancels a chunked body immediately above the byte limit", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const request = new Request("https://gateway.invalid/messages", {
    method: "POST",
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode("oversized"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedRequestBody(request, 4),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "REQUEST_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});

test("bounded request cancels a stalled body at its deadline", async () => {
  let cancelled = false;
  const request = new Request("https://gateway.invalid/messages", {
    method: "POST",
    body: new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedRequestBody(request, 10, 10),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "REQUEST_BODY_TIMEOUT",
  );
  assert.equal(cancelled, true);
});

test("oversize rejection does not wait for an unread cloned branch", async () => {
  const request = new Request("https://gateway.invalid/messages", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        readBoundedRequestBody(request.clone(), 8),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Rejection hung")), 500);
        }),
      ]),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "REQUEST_TOO_LARGE",
    );
  } finally {
    clearTimeout(timer);
    await request.body!.cancel();
  }
});

test("body deadline does not wait for a stalled transport cancellation", async () => {
  const request = new Request("https://gateway.invalid/messages", {
    method: "POST",
    body: new ReadableStream({
      cancel() {
        return new Promise(() => undefined);
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        readBoundedRequestBody(request, 8, 10),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Rejection hung")), 500);
        }),
      ]),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "REQUEST_BODY_TIMEOUT",
    );
  } finally {
    clearTimeout(timer);
  }
});

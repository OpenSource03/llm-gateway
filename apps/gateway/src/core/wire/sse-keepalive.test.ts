import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream } from "./sse";
import { withSseKeepalive } from "./sse-keepalive";

const readWithDeadline = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 250,
) =>
  Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("SSE keepalive test timed out")),
        timeoutMs,
      ),
    ),
  ]);

test("emits protocol comments while an SSE source is quiet", async () => {
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
    },
  });
  const response = withSseKeepalive(
    new Response(source, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    { intervalMs: 5 },
  );
  const reader = response.body!.getReader();

  assert.equal(
    new TextDecoder().decode((await readWithDeadline(reader)).value),
    ": keepalive\n\n",
  );

  upstream!.enqueue(
    new TextEncoder().encode('event: update\ndata: {"ok":true}\n\n'),
  );
  assert.equal(
    new TextDecoder().decode((await readWithDeadline(reader)).value),
    'event: update\ndata: {"ok":true}\n\n',
  );
  upstream!.close();
  assert.equal((await readWithDeadline(reader)).done, true);
});

test("keepalive comments are invisible to SSE event parsing", async () => {
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
    },
  });
  const response = withSseKeepalive(
    new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }),
    { intervalMs: 5 },
  );
  const framesPromise = (async () => {
    const frames = [];

    for await (const frame of parseSseStream(response.body!))
      frames.push(frame);

    return frames;
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  upstream!.enqueue(new TextEncoder().encode("event: done\ndata: [DONE]\n\n"));
  upstream!.close();

  assert.deepEqual(await framesPromise, [{ event: "done", data: "[DONE]" }]);
});

test("propagates downstream cancellation to the SSE source", async () => {
  let cancellationReason: unknown;
  const source = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancellationReason = reason;
    },
  });
  const response = withSseKeepalive(
    new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }),
    { intervalMs: 5 },
  );
  const reader = response.body!.getReader();

  await readWithDeadline(reader);
  await reader.cancel("client disconnected");

  assert.equal(cancellationReason, "client disconnected");
});

test("cancels promptly while a downstream read is pending", async () => {
  let cancellationReason: unknown;
  const source = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancellationReason = reason;
    },
  });
  const response = withSseKeepalive(
    new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }),
    { intervalMs: 1_000 },
  );
  const reader = response.body!.getReader();
  const pendingRead = reader.read();

  await Promise.race([
    reader.cancel("client disconnected while waiting"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("SSE cancellation timed out")), 250),
    ),
  ]);
  assert.equal((await pendingRead).done, true);
  assert.equal(cancellationReason, "client disconnected while waiting");
});

test("leaves non-SSE responses untouched", () => {
  const response = new Response('{"ok":true}', {
    headers: { "content-type": "application/json" },
  });

  assert.equal(withSseKeepalive(response), response);
});

test("rejects invalid keepalive intervals", () => {
  const response = new Response("event: done\ndata: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

  assert.throws(
    () => withSseKeepalive(response, { intervalMs: 0 }),
    /interval must be positive/,
  );
});

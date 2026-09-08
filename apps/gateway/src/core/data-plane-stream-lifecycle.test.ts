import type { LeaseHandle } from "./leases";

import assert from "node:assert/strict";
import test from "node:test";

import { wrapStreamLifecycle } from "./data-plane.service";
import { createLeaseGuard } from "./leases";

for (const terminal of [true, false]) {
  test(`request signal abort ${terminal ? "after" : "before"} terminal is classified and accounted correctly`, async () => {
    const client = new AbortController();
    const guard = createLeaseGuard({
      signal: client.signal,
      ttlMs: 120_000,
      heartbeatIntervalMs: 30_000,
      dependencies: { release: async () => undefined },
    });
    let calls = 0;
    let result: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            terminal
              ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":42,"output_tokens":7,"input_tokens_details":{"cached_tokens":5}}}}\n\n'
              : ": keepalive\n\n",
          ),
        );
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const response = wrapStreamLifecycle(
      new Response(upstream, {
        headers: { "content-type": "text/event-stream" },
      }),
      guard,
      async (error, usage, diagnostics) => {
        calls++;
        result = {
          error: error instanceof Error ? error.name : error,
          usage,
          diagnostics,
        };
      },
      { publicProtocol: "responses", clientSignal: client.signal },
    );
    const reader = response.body!.getReader();
    await reader.read();
    // Hono's connection-close reason is a string, explaining historical null errorClass.
    client.abort("Client connection prematurely closed.");
    if (terminal) assert.equal((await reader.read()).done, true);
    else await assert.rejects(reader.read(), /ClientStreamCancelled/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    const recorded = result as {
      error: unknown;
      usage: unknown;
      diagnostics: { termination: string; terminalReceived: boolean };
    };
    assert.equal(
      recorded.error,
      terminal ? undefined : "ClientStreamCancelled",
    );
    assert.deepEqual(
      recorded.usage,
      terminal ? { input: 37, cached: 5, output: 7 } : {},
    );
    assert.equal(recorded.diagnostics.termination, "client_abort");
    assert.equal(recorded.diagnostics.terminalReceived, terminal);
    assert.ok(!JSON.stringify(recorded).includes("prematurely"));
  });
}

const lease: LeaseHandle = {
  leaseKey: "CLIENT_CONCURRENCY:test:0",
  kind: "CLIENT_CONCURRENCY",
  resourceId: "test",
  slot: 0,
  ownerId: "owner",
  expiresAt: new Date(Date.now() + 120_000),
};

for (const [frame, expected] of [
  [": keepalive\n\n", "UpstreamStreamTruncated"],
  [
    'data: {"type":"response.failed","response":{"error":{"message":"private-provider-detail"}}}\n\n',
    "UpstreamStreamError",
  ],
] as const) {
  test(`EOF records the safe ${expected} category`, async () => {
    let recorded: unknown;
    const response = wrapStreamLifecycle(
      new Response(frame),
      [lease],
      async (error) => {
        recorded = error;
      },
      {
        publicProtocol: "responses",
        dependencies: {
          heartbeat: async () => true,
          release: async () => undefined,
          heartbeatIntervalMs: 30_000,
        },
      },
    );
    await response.text();
    assert.ok(recorded instanceof Error);
    assert.equal(recorded.name, expected);
    assert.ok(!recorded.message.includes("private-provider-detail"));
  });
}

test("transport diagnostics never retain provider-controlled error names or messages", async () => {
  let recorded: unknown;
  const response = wrapStreamLifecycle(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error({
            name: "private-provider-detail",
            message: "private-provider-detail",
          });
        },
      }),
    ),
    [lease],
    async (error) => {
      recorded = error;
    },
    {
      publicProtocol: "responses",
      dependencies: {
        heartbeat: async () => true,
        release: async () => undefined,
        heartbeatIntervalMs: 30_000,
      },
    },
  );
  await assert.rejects(response.text(), /UpstreamTransportError/);
  assert.ok(recorded instanceof Error);
  assert.equal(recorded.name, "UpstreamTransportError");
  assert.ok(!JSON.stringify(recorded).includes("private-provider-detail"));
});

const exerciseLeaseLoss = async (
  heartbeat: () => Promise<boolean>,
  readAfterLoss = true,
): Promise<{ cancelled: boolean; finalizedWithError: boolean }> => {
  let cancelled = false;
  let finalizedWithError = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = wrapStreamLifecycle(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    [lease],
    async (error) => {
      finalizedWithError = error instanceof Error;
    },
    {
      dependencies: {
        heartbeat,
        release: async () => undefined,
        heartbeatIntervalMs: 1,
      },
    },
  );
  const reader = response.body!.getReader();

  assert.equal((await reader.read()).done, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (readAfterLoss)
    await assert.rejects(reader.read(), /distributed lease was lost/);

  return { cancelled, finalizedWithError };
};

test("a false stream heartbeat cancels upstream and finalizes as an error", async () => {
  assert.deepEqual(await exerciseLeaseLoss(async () => false), {
    cancelled: true,
    finalizedWithError: true,
  });
});

test("a failed stream heartbeat cancels upstream and finalizes as an error", async () => {
  assert.deepEqual(
    await exerciseLeaseLoss(async () => {
      throw new Error("database unavailable");
    }),
    { cancelled: true, finalizedWithError: true },
  );
});

test("lease loss finalizes even when the downstream stops pulling", async () => {
  assert.deepEqual(await exerciseLeaseLoss(async () => false, false), {
    cancelled: true,
    finalizedWithError: true,
  });
});

test("abort finalizes without waiting for an upstream cancel promise", async () => {
  let finalized = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const response = wrapStreamLifecycle(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    [lease],
    async (error) => {
      finalized = error instanceof Error;
    },
    {
      dependencies: {
        heartbeat: async () => false,
        release: async () => undefined,
        heartbeatIntervalMs: 1,
      },
    },
  );

  await response.body!.getReader().read();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finalized, true);
});

test("downstream cancel before a terminal event finalizes as an error", async () => {
  let completionError: unknown;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const response = wrapStreamLifecycle(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    [lease],
    async (error) => {
      completionError = error;
    },
    {
      dependencies: {
        heartbeat: async () => true,
        release: async () => undefined,
        heartbeatIntervalMs: 100,
      },
    },
  );
  const reader = response.body!.getReader();

  await reader.read();
  await Promise.race([
    reader.cancel(false),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cancel finalization timed out")), 100),
    ),
  ]);
  assert.ok(completionError instanceof Error);
});

test("downstream cancel after a terminal event finalizes as success", async () => {
  let completionError: unknown = "not finalized";
  let observed: { input?: number; output?: number; cached?: number } = {};
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":42,"output_tokens":7,"input_tokens_details":{"cached_tokens":5}}}}\n\n',
        ),
      );
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const response = wrapStreamLifecycle(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    [lease],
    async (error, usage) => {
      completionError = error;
      observed = usage;
    },
    {
      dependencies: {
        heartbeat: async () => true,
        release: async () => undefined,
        heartbeatIntervalMs: 100,
      },
      publicProtocol: "responses",
    },
  );
  const reader = response.body!.getReader();

  await reader.read();
  await reader.cancel();
  assert.equal(completionError, undefined);
  assert.deepEqual(observed, { input: 37, output: 7, cached: 5 });
});

test("native Claude split terminal usage preserves input and output fields", async () => {
  let observed: { input?: number; output?: number; cached?: number } = {};
  const response = wrapStreamLifecycle(
    new Response(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
    [lease],
    async (_error, usage) => {
      observed = usage;
    },
    {
      dependencies: {
        heartbeat: async () => true,
        release: async () => undefined,
        heartbeatIntervalMs: 100,
      },
    },
  );

  await response.text();
  assert.deepEqual(observed, { input: 42, output: 7, cached: 5 });
});

test("native Codex terminal event preserves Responses usage", async () => {
  let observed: { input?: number; output?: number; cached?: number } = {};
  const response = wrapStreamLifecycle(
    new Response(
      [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":42,"output_tokens":7,"input_tokens_details":{"cached_tokens":5}}}}\n\n',
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
    [lease],
    async (_error, usage) => {
      observed = usage;
    },
    {
      dependencies: {
        heartbeat: async () => true,
        release: async () => undefined,
        heartbeatIntervalMs: 100,
      },
      publicProtocol: "responses",
    },
  );

  await response.text();
  assert.deepEqual(observed, { input: 37, output: 7, cached: 5 });
});

test("lease abort discards already queued downstream bytes", async () => {
  const response = wrapStreamLifecycle(
    new Response(": queued\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
    [lease],
    async () => undefined,
    {
      dependencies: {
        heartbeat: async () => false,
        release: async () => undefined,
        heartbeatIntervalMs: 1,
      },
    },
  );
  const reader = response.body!.getReader();

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(reader.read(), /distributed lease was lost/);
});

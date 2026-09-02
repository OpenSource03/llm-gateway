const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const SSE_CONTENT_TYPE = "text/event-stream";
const KEEPALIVE_COMMENT = new TextEncoder().encode(": keepalive\n\n");

interface SseKeepaliveOptions {
  intervalMs?: number;
}

type Wakeup = { kind: "keepalive" } | { kind: "cancelled" };

const createWakeup = (intervalMs: number) => {
  let settle: ((result: Wakeup) => void) | undefined;
  let settled = false;
  const promise = new Promise<Wakeup>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => {
    settled = true;
    settle?.({ kind: "keepalive" });
  }, intervalMs);

  timer.unref?.();

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle?.({ kind: "cancelled" });
    },
  };
};

/**
 * Keeps an SSE response alive without changing its protocol events.
 *
 * The wrapper emits only SSE comments, which clients ignore and which never
 * enter provider prompts, outputs, or token accounting. It keeps at most one
 * upstream read in flight and emits only when the downstream requests data,
 * preserving backpressure and cancellation.
 */
export const withSseKeepalive = (
  response: Response,
  options: SseKeepaliveOptions = {},
): Response => {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes(SSE_CONTENT_TYPE)
  ) {
    return response;
  }
  const intervalMs = options.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("SSE keepalive interval must be positive");
  }

  const reader = response.body.getReader();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let wakeup: ReturnType<typeof createWakeup> | undefined;
  let finished = false;

  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock until cancellation settles it.
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    wakeup?.cancel();
    wakeup = undefined;
    releaseReader();
  };
  const cancelUpstream = async (reason: unknown) => {
    if (finished) return;
    finished = true;
    wakeup?.cancel();
    wakeup = undefined;
    await reader.cancel(reason).catch(() => undefined);
    releaseReader();
  };

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) return;
        pendingRead ??= reader.read();
        const currentRead = pendingRead;

        const currentWakeup = createWakeup(intervalMs);

        wakeup = currentWakeup;
        try {
          const result = await Promise.race([
            currentRead.then((read) => ({ kind: "read" as const, read })),
            currentWakeup.promise,
          ]);

          currentWakeup.cancel();
          if (wakeup === currentWakeup) wakeup = undefined;
          if (result.kind === "cancelled" || finished) return;
          if (result.kind === "keepalive") {
            controller.enqueue(KEEPALIVE_COMMENT.slice());
            return;
          }

          pendingRead = undefined;
          if (result.read.done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(result.read.value);
        } catch (error) {
          await cancelUpstream(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancelUpstream(reason);
      },
    },
    // Do not prefetch provider bytes before the downstream asks for them. This
    // preserves the lifecycle wrapper's guarantee that lease loss can discard
    // bytes which have not yet been delivered to the client.
    { highWaterMark: 0 },
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

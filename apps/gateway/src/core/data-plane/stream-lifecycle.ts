import {
  createLeaseGuard,
  GatewayLeaseLostError,
  heartbeatLease,
  type LeaseGuard,
  type LeaseHandle,
  releaseLeases,
} from "../leases";
import {
  combinedCachedInputTokens,
  uncachedResponsesInputTokens,
} from "../usage-accounting";

const LEASE_TTL_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;

interface StreamLeaseDependencies {
  heartbeat: typeof heartbeatLease;
  release: typeof releaseLeases;
  heartbeatIntervalMs: number;
}

interface StreamLifecycleOptions {
  dependencies?: StreamLeaseDependencies;
  publicProtocol?: "anthropic" | "responses";
}

export const wrapStreamLifecycle = (
  response: Response,
  leaseOwner: LeaseGuard | LeaseHandle[],
  onComplete: (error: unknown, usage: ObservedUsage) => Promise<void>,
  options: StreamLifecycleOptions = {},
): Response => {
  const dependencies = options.dependencies ?? {
    heartbeat: heartbeatLease,
    release: releaseLeases,
    heartbeatIntervalMs: LEASE_HEARTBEAT_MS,
  };
  const guard = Array.isArray(leaseOwner)
    ? createLeaseGuard({
        leases: leaseOwner,
        ttlMs: LEASE_TTL_MS,
        heartbeatIntervalMs: dependencies.heartbeatIntervalMs,
        dependencies: {
          heartbeat: dependencies.heartbeat,
          release: dependencies.release,
        },
      })
    : leaseOwner;

  if (!response.body) {
    void Promise.allSettled([guard.finish(), onComplete(undefined, {})]);

    return response;
  }
  const reader = response.body.getReader();
  const observer =
    options.publicProtocol === "responses"
      ? createResponsesStreamObserver()
      : createAnthropicStreamObserver();
  let finalized = false;
  let lifecycleError: unknown;
  let downstreamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const finalize = async (error?: unknown) => {
    if (finalized) return;
    finalized = true;
    guard.signal.removeEventListener("abort", abortUpstream);
    await Promise.allSettled([
      guard.finish(),
      onComplete(error, observer.usage),
    ]);
  };
  const abortUpstream = () => {
    if (finalized) return;
    lifecycleError =
      guard.signal.reason ?? new GatewayLeaseLostError("Lease guard aborted");
    try {
      downstreamController?.error(lifecycleError);
    } catch {
      // The downstream may already be closed/cancelled; finalization remains
      // independent and idempotent.
    }
    // Finalization must not wait for a broken provider stream's cancel promise;
    // accounting and concurrency leases are released independently.
    void finalize(lifecycleError);
    void reader.cancel(lifecycleError).catch(() => undefined);
  };

  guard.signal.addEventListener("abort", abortUpstream, { once: true });
  if (guard.signal.aborted) abortUpstream();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstreamController = controller;
      if (lifecycleError) controller.error(lifecycleError);
    },
    async pull(controller) {
      try {
        if (lifecycleError) throw lifecycleError;
        const result = await reader.read();

        if (lifecycleError) throw lifecycleError;
        if (result.done) {
          const terminalError = observer.finish();

          controller.close();
          await finalize(terminalError);
        } else {
          observer.observe(result.value);
          controller.enqueue(result.value);
        }
      } catch (error) {
        await finalize(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      const observerError = observer.finish();
      const cancellationError = observerError
        ? observerError
        : reason instanceof Error
          ? reason
          : new Error("Downstream stream cancelled", { cause: reason });

      // Codex closes some upstream streams as soon as it receives the
      // protocol's terminal event, before reading transport EOF. That is a
      // completed response, not a truncation. A pre-terminal cancellation
      // still fails closed and retains conservative accounting.
      await finalize(observerError ? cancellationError : undefined);
      void reader.cancel(cancellationError).catch(() => undefined);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export interface ObservedUsage {
  /** Ordinary input only; cached input is always reported separately. */
  input?: number;
  output?: number;
  cached?: number;
}

const createAnthropicStreamObserver = () => {
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let failed = false;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  const usage: ObservedUsage = {};
  const processFrame = (raw: string) => {
    const eventName = raw
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (eventName === "message_stop") terminal = true;
    if (eventName === "error") failed = true;
    if (!data || data === "[DONE]") return;
    try {
      const value = JSON.parse(data) as {
        type?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        message?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
      };
      const current = value.usage ?? value.message?.usage;
      const terminalOutputFrame =
        value.type === "message_delta" || value.type === "message_stop";

      // Native Anthropic normally reports input/cache on message_start and
      // output on the final message_delta. Never accept message_start's
      // placeholder output=0 as terminal usage.
      if (typeof current?.input_tokens === "number")
        usage.input = current.input_tokens;
      if (terminalOutputFrame && typeof current?.output_tokens === "number")
        usage.output = current.output_tokens;
      if (typeof current?.cache_read_input_tokens === "number") {
        cacheReadInputTokens = current.cache_read_input_tokens;
      }
      if (typeof current?.cache_creation_input_tokens === "number") {
        cacheCreationInputTokens = current.cache_creation_input_tokens;
      }
      const cached = combinedCachedInputTokens(
        cacheReadInputTokens,
        cacheCreationInputTokens,
      );

      if (cached !== undefined) {
        usage.cached = cached;
      }
      if (value.type === "message_stop") terminal = true;
      if (value.type === "error") failed = true;
    } catch {
      // Unknown forward-compatible event payloads do not affect telemetry.
    }
  };
  const drain = () => {
    let boundary: number;

    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      processFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  };

  return {
    usage,
    observe(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      drain();
    },
    finish(): Error | undefined {
      buffer += decoder.decode();
      drain();

      if (failed) return new Error("UpstreamStreamError");
      if (!terminal) return new Error("UpstreamStreamTruncated");

      return undefined;
    },
  };
};

const createResponsesStreamObserver = () => {
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let failed = false;
  let totalInputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  const usage: ObservedUsage = {};
  const processFrame = (raw: string) => {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data || data === "[DONE]") return;
    try {
      const value = JSON.parse(data) as {
        type?: string;
        response?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
        };
      };
      const current = value.response?.usage;

      if (typeof current?.input_tokens === "number")
        totalInputTokens = current.input_tokens;
      if (typeof current?.output_tokens === "number")
        usage.output = current.output_tokens;
      if (typeof current?.input_tokens_details?.cached_tokens === "number") {
        cachedInputTokens = current.input_tokens_details.cached_tokens;
        usage.cached = cachedInputTokens;
      }
      usage.input = uncachedResponsesInputTokens(
        totalInputTokens,
        cachedInputTokens,
      );
      if (
        value.type === "response.completed" ||
        value.type === "response.incomplete"
      ) {
        terminal = true;
      }
      if (value.type === "response.failed" || value.type === "error") {
        terminal = true;
        failed = true;
      }
    } catch {
      // Unknown forward-compatible event payloads do not affect telemetry.
    }
  };
  const drain = () => {
    let boundary: number;

    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      processFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  };

  return {
    usage,
    observe(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      drain();
    },
    finish(): Error | undefined {
      buffer += decoder.decode();
      drain();

      if (failed) return new Error("UpstreamStreamError");
      if (!terminal) return new Error("UpstreamStreamTruncated");

      return undefined;
    },
  };
};

export const extractResponseUsage = async (
  response: Response,
  publicProtocol: "anthropic" | "responses",
): Promise<ObservedUsage> => {
  if (!response.headers.get("content-type")?.includes("application/json"))
    return {};
  try {
    const body = (await response.clone().json()) as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };

    if (publicProtocol === "responses") {
      const cached = body.usage?.input_tokens_details?.cached_tokens;

      return {
        input: uncachedResponsesInputTokens(body.usage?.input_tokens, cached),
        output: body.usage?.output_tokens,
        cached,
      };
    }

    return {
      input: body.usage?.input_tokens,
      output: body.usage?.output_tokens,
      cached: combinedCachedInputTokens(
        body.usage?.cache_read_input_tokens,
        body.usage?.cache_creation_input_tokens,
      ),
    };
  } catch {
    return {};
  }
};

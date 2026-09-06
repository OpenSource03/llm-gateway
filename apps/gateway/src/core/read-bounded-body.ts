import { GatewayError } from "./errors";

const DEFAULT_BODY_TIMEOUT_MS = 30_000;

/** Read a request incrementally, enforcing both a byte ceiling and deadline. */
export const readBoundedRequestBody = async (
  request: Request,
  maxBytes: number,
  timeoutMs = DEFAULT_BODY_TIMEOUT_MS,
): Promise<Uint8Array> => {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error("Request body deadline exceeded")),
    timeoutMs,
  );
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () => reject(signal.reason);

          if (signal.aborted) {
            abort();

            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          void reader
            .read()
            .then(resolve, reject)
            .finally(() => {
              signal.removeEventListener("abort", abort);
            });
        },
      );

      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new GatewayError(
          "Request body is too large",
          413,
          "REQUEST_TOO_LARGE",
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    // A tee branch or a broken transport can keep cancel() pending forever.
    // Start cancellation but never let cleanup prevent the bounded rejection.
    void reader.cancel(error).catch(() => undefined);
    if (error instanceof GatewayError) throw error;
    if (timeoutController.signal.aborted) {
      throw new GatewayError(
        "Request body timed out",
        408,
        "REQUEST_BODY_TIMEOUT",
      );
    }
    if (request.signal.aborted) {
      throw new GatewayError("Request was cancelled", 400, "REQUEST_CANCELLED");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};

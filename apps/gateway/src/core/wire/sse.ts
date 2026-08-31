export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

const MAX_SSE_FRAME_BYTES = 1024 * 1024;

/** Parses SSE across arbitrary chunks, UTF-8 splits, CRLFs, comments, and multiline data. */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failure: unknown;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };

  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_FRAME_BYTES) {
        throw new Error("Upstream SSE frame exceeded the gateway limit");
      }
      buffer = normalizeNewlines(buffer, false);
      let boundary: number;

      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundary);

        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(raw);

        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    buffer = normalizeNewlines(buffer, true);
    const parsed = parseSseFrame(buffer);

    if (parsed) yield parsed;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    // If the consumer stops early (HTTP client disconnect, transform error,
    // or cancellation), propagate that cancellation to the provider socket.
    await reader
      .cancel(signal?.aborted ? signal.reason : failure)
      .catch(() => undefined);
    reader.releaseLock();
  }
}

function normalizeNewlines(value: string, final: boolean): string {
  // Preserve a trailing CR until the next chunk so a split CRLF remains one
  // newline instead of looking like an empty SSE line.
  const trailingCr = !final && value.endsWith("\r");
  const complete = trailingCr ? value.slice(0, -1) : value;

  return (
    complete.replace(/\r\n/g, "\n").replace(/\r/g, "\n") +
    (trailingCr ? "\r" : "")
  );
}

function parseSseFrame(raw: string): SseFrame | null {
  if (!raw.trim()) return null;
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  if (
    data.length === 0 &&
    event === undefined &&
    id === undefined &&
    retry === undefined
  )
    return null;

  return {
    data: data.join("\n"),
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

export function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const json = typeof data === "string" ? data : JSON.stringify(data);

  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

export function encodeSseFrame(frame: SseFrame): Uint8Array {
  const lines: string[] = [];

  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.retry !== undefined) lines.push(`retry: ${frame.retry}`);
  for (const line of frame.data.split("\n")) lines.push(`data: ${line}`);

  return new TextEncoder().encode(`${lines.join("\n")}\n\n`);
}

export function streamFromStrings(
  chunks: string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

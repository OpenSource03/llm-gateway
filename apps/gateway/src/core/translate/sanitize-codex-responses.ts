import { encodeSseEvent, encodeSseFrame, parseSseStream } from "../wire/sse";
import { restorePlaintextCollaborationItem } from "./plaintext-collaboration";

type PlaintextCollaborationTools = Parameters<
  typeof restorePlaintextCollaborationItem
>[1];

const publicFailure = () => ({
  type: "response.failed",
  response: {
    id: "resp_gateway_error",
    error: {
      type: "server_error",
      code: "upstream_failure",
      message: "Upstream provider request failed",
      param: null,
    },
  },
});

async function* sanitizeFrames(
  upstream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  plaintextTools: PlaintextCollaborationTools = new Map(),
): AsyncGenerator<Uint8Array> {
  for await (const frame of parseSseStream(upstream, signal)) {
    if (frame.data === "[DONE]") {
      yield encodeSseFrame(frame);
      continue;
    }
    if (!frame.data) continue;
    let payload: Record<string, unknown>;

    try {
      const parsed = JSON.parse(frame.data) as unknown;

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("Responses SSE payload must be an object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      yield encodeSseEvent("response.failed", publicFailure());

      return;
    }
    if (
      frame.event === "error" ||
      frame.event === "response.failed" ||
      payload.type === "error" ||
      payload.type === "response.failed"
    ) {
      yield encodeSseEvent("response.failed", publicFailure());

      return;
    }
    if (plaintextTools.size === 0) {
      yield encodeSseFrame(frame);
      continue;
    }
    try {
      if (
        payload.item &&
        typeof payload.item === "object" &&
        !Array.isArray(payload.item)
      ) {
        payload.item = restorePlaintextCollaborationItem(
          payload.item as Record<string, unknown>,
          plaintextTools,
        );
      }
      const response = payload.response as Record<string, unknown> | undefined;
      if (response && Array.isArray(response.output)) {
        response.output = response.output.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? restorePlaintextCollaborationItem(
                item as Record<string, unknown>,
                plaintextTools,
              )
            : item,
        );
      }
      yield encodeSseFrame({ ...frame, data: JSON.stringify(payload) });
    } catch {
      yield encodeSseEvent("response.failed", publicFailure());
      return;
    }
  }
}

/** Preserve native Responses events while redacting in-band provider errors. */
export function sanitizeCodexResponsesStream(
  upstream: ReadableStream<Uint8Array>,
  plaintextTools?: PlaintextCollaborationTools,
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const frames = sanitizeFrames(upstream, cancellation.signal, plaintextTools);

  return new ReadableStream({
    async pull(controller) {
      const next = await frames.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      cancellation.abort(reason);
      await frames.return(undefined);
    },
  });
}

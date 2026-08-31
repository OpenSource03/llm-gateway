import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "./sse";

test("SSE parser handles split UTF-8, split CRLF, comments, and multiline data", async () => {
  const source = "😀";
  const bytes = new TextEncoder().encode(source);
  const emojiHead = new TextDecoder().decode(bytes.slice(0, 2));

  assert.equal(
    emojiHead,
    "�",
    "fixture confirms the character is split mid-codepoint",
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keepalive\r"));
      controller.enqueue(new TextEncoder().encode("\nevent: update\r"));
      controller.enqueue(
        new TextEncoder().encode("\nid: 7\r\ndata: first\r\ndata: "),
      );
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.enqueue(new TextEncoder().encode("\r\nretry: 1500\r"));
      controller.enqueue(
        new TextEncoder().encode("\n\r\nevent: done\ndata: [DONE]\n\n"),
      );
      controller.close();
    },
  });

  const frames = [];

  for await (const frame of parseSseStream(stream)) frames.push(frame);

  assert.deepEqual(frames, [
    { event: "update", id: "7", retry: 1500, data: `first\n${source}` },
    { event: "done", data: "[DONE]" },
  ]);
});

test("SSE parser flushes a final unterminated event", async () => {
  const frames = [];

  for await (const frame of parseSseStream(
    streamFromStrings(["event: final\ndata: ok"]),
  )) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: "final", data: "ok" }]);
});

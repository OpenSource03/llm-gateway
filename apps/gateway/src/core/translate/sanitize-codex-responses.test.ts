import assert from "node:assert/strict";
import test from "node:test";

import { parseSseStream, streamFromStrings } from "../wire/sse";

import { sanitizeCodexResponsesStream } from "./sanitize-codex-responses";

test("native Codex stream sanitizer preserves success events", async () => {
  const stream = sanitizeCodexResponsesStream(
    streamFromStrings([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":null}}\n\n',
    ]),
  );
  const events = [];

  for await (const frame of parseSseStream(stream)) events.push(frame);
  assert.deepEqual(
    events.map((event) => event.event),
    ["response.output_text.delta", "response.completed"],
  );
});

test("native Codex stream sanitizer redacts provider failure details", async () => {
  const stream = sanitizeCodexResponsesStream(
    streamFromStrings([
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"workspace secret detail"}}}\n\n',
    ]),
  );
  const text = await new Response(stream).text();

  assert.doesNotMatch(text, /workspace secret detail/);
  assert.match(text, /Upstream provider request failed/);
});

test("native Codex stream sanitizer never exposes a non-SSE success body", async () => {
  const stream = sanitizeCodexResponsesStream(
    streamFromStrings(['{"error":"raw provider detail"}']),
  );
  const text = await new Response(stream).text();

  assert.doesNotMatch(text, /raw provider detail/);
});

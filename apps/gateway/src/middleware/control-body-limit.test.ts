import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import {
  limitControlRequestBody,
  MAX_CONTROL_REQUEST_BYTES,
} from "./control-body-limit";

test("control body limiting preserves bounded JSON for downstream parsing", async () => {
  const app = new Hono();

  app.use("*", limitControlRequestBody);
  app.post("/", async (context) => context.json(await context.req.json()));
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("control body limiting cancels oversized chunked input", async () => {
  let cancelled = false;
  const app = new Hono();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_CONTROL_REQUEST_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });

  app.onError((error, context) =>
    context.json(
      { code: "code" in error ? error.code : "INTERNAL_ERROR" },
      "status" in error ? (error.status as 413) : 500,
    ),
  );
  app.use("*", limitControlRequestBody);
  app.post("/", (context) => context.text("unreachable"));
  const response = await app.request("/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & {
    duplex: "half";
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: "REQUEST_TOO_LARGE" });
  assert.equal(cancelled, true);
});

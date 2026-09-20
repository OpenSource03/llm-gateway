import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectCheckpoint,
  classifyStderr,
  requireStorage,
  rejectResumeFallback,
  safeTransportFields,
  countToolResults,
} from "./session-diagnostics-runtime.mjs";
import { patchSessionDiagnostics } from "./session-diagnostics.mjs";

async function fixture(t, records) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-checkpoint-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "session.jsonl");
  await writeFile(
    file,
    records
      .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
      .join("\n") + "\n",
  );
  return file;
}
const root = {
  type: "user",
  uuid: "root",
  parentUuid: null,
  message: { content: "synthetic" },
};
const reply = {
  type: "assistant",
  uuid: "reply",
  parentUuid: "root",
  message: { content: "synthetic" },
};

test("accepts complete native checkpoint without exposing content", async (t) => {
  const result = await inspectCheckpoint(await fixture(t, [root, reply]));
  assert.equal(result.valid, true);
  assert.equal(result.messages, 2);
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
});
test("accepts a checkpoint holding one very large record (pasted media)", async (t) => {
  const huge = {
    type: "user",
    uuid: "root",
    parentUuid: null,
    message: { content: "x".repeat(20 * 1024 * 1024) },
  };
  const result = await inspectCheckpoint(await fixture(t, [huge, reply]));

  assert.equal(result.valid, true);
  assert.equal(result.messages, 2);
});
test("rejects partial JSON followed by metadata (disk-full incident)", async (t) => {
  const result = await inspectCheckpoint(
    await fixture(t, [
      '{"type":"user","message":{"content":"partial' +
        JSON.stringify({ type: "queue-operation" }),
      { type: "mode" },
    ]),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_json");
  assert.equal(result.badLine, 1);
  assert.equal(JSON.stringify(result).includes("partial"), false);
});
test("rejects fallback containing only new assistant response and tool results", async (t) => {
  const result = await inspectCheckpoint(
    await fixture(t, [
      reply,
      { type: "user", uuid: "result", parentUuid: "reply" },
    ]),
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_history");
});
test("rejects metadata-only and empty checkpoint", async (t) => {
  for (const rows of [[], [{ type: "mode" }]])
    assert.equal(
      (await inspectCheckpoint(await fixture(t, rows))).valid,
      false,
    );
});
test("rejects valid JSON scalar instead of a record", async (t) => {
  assert.equal(
    (await inspectCheckpoint(await fixture(t, ["null"]))).reason,
    "invalid_record",
  );
});
test("classifies stderr without returning raw provider errors or secrets", () => {
  assert.equal(
    classifyStderr("secret-data: ENOSPC: no space left on device"),
    "ENOSPC",
  );
  assert.equal(
    classifyStderr("No conversation found with session ID secret"),
    "SESSION_MISSING",
  );
  assert.equal(classifyStderr("arbitrary prompt or credential"), "OTHER");
});
test("storage guard rejects insufficient capacity and supports not-yet-created profile", async () => {
  await assert.rejects(
    requireStorage(tmpdir(), Number.MAX_SAFE_INTEGER),
    /insufficient capacity/,
  );
  assert.ok(
    (
      await requireStorage(
        join(tmpdir(), "nonexistent-gateway-profile", "nested"),
        0,
      )
    ).totalBytes > 0,
  );
});
test("resume failure is explicit instead of falling through to fresh replay", () => {
  assert.throws(
    () => rejectResumeFallback("synthetic-request", "unresumable"),
    /automatic context-loss replay was blocked/,
  );
});
test("distribution patch fails closed against unexpected code", () => {
  assert.throws(
    () => patchSessionDiagnostics("unrecognized upstream version"),
    /Unsupported Meridian/,
  );
});

test("transport diagnostics use an allowlist even for nested errors and credentials", () => {
  const sentinel = "DO_NOT_LOG_PRIVATE_DATA";
  const safe = safeTransportFields(
    {
      error: "ENOSPC " + sentinel,
      stderr: "ENOSPC " + sentinel,
      messages: [sentinel],
      content: sentinel,
      token: sentinel,
      authorization: sentinel,
      secret: { anything: sentinel },
      path: sentinel,
      unknown: sentinel,
      status: 503,
      sessionId: sentinel,
    },
    { requestId: sentinel },
  );
  assert.equal(safe.status, 503);
  assert.equal(safe.failureReason, "ENOSPC");
  assert.ok(!JSON.stringify(safe).includes(sentinel));
  assert.deepEqual(Object.keys(safe).sort(), [
    "failureReason",
    "request",
    "sessionIdHash",
    "status",
  ]);
});
test("continuity diagnostics keep code labels and counts but drop free text", () => {
  const safe = safeTransportFields({
    lineage: "continuation",
    reason: "incomplete_or_mismatched_results",
    expectedToolIds: 1,
    receivedToolResults: 2,
  });
  assert.deepEqual(safe, {
    lineage: "continuation",
    reason: "incomplete_or_mismatched_results",
    expectedToolIds: 1,
    receivedToolResults: 2,
  });
  assert.deepEqual(
    safeTransportFields({ reason: "Prompt said: delete everything" }),
    {},
  );
});
test("tool result counting ignores text and malformed messages", () => {
  assert.equal(
    countToolResults([
      { role: "user", content: [{ type: "tool_result" }, { type: "text" }] },
      { role: "user", content: "plain" },
      null,
      { role: "user", content: [{ type: "tool_result" }] },
    ]),
    2,
  );
});

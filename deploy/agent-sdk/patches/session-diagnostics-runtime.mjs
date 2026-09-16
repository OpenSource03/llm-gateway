import { createReadStream } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";

// This module must never emit paths, messages, tool data, or raw errors.
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const knownCodes = new Set([
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "ENOENT",
  "EACCES",
  "EMFILE",
  "ENFILE",
  "EFBIG",
]);
const safeCode = (error) =>
  knownCodes.has(error?.code) ? error.code : "UNKNOWN";
export const emitDiagnostic = (event, fields = {}) => {
  process.stderr.write(
    JSON.stringify({
      component: "gateway-session",
      event,
      time: new Date().toISOString(),
      ...fields,
    }) + "\n",
  );
};

const numericFields = new Set([
  "status",
  "statusCode",
  "attempt",
  "durationMs",
  "ageMs",
  "sessionQueueWaitMs",
  "bytesSent",
  "streamEventsSeen",
  "eventsForwarded",
  "textEventsForwarded",
  "inputTokens",
  "outputTokens",
  "messageCount",
  "toolCount",
  "sinceLastMs",
  "retryAfterMs",
]);
const booleanFields = new Set([
  "isResume",
  "isUndo",
  "stream",
  "recovered",
  "recoveryAttempted",
  "aborted",
]);
export function safeTransportFields(extra = {}, context = {}) {
  const output = {};
  for (const [key, value] of Object.entries({ ...context, ...extra })) {
    if (
      numericFields.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      output[key] = value;
    else if (booleanFields.has(key) && typeof value === "boolean")
      output[key] = value;
    else if (key === "requestId" && typeof value === "string")
      output.request = digest(value);
    else if (
      [
        "sessionId",
        "resumeSessionId",
        "sdkSessionId",
        "profileId",
        "profile",
      ].includes(key) &&
      typeof value === "string"
    )
      output[key + "Hash"] = digest(value);
    else if (key === "error" || key === "stderr") {
      output.failureReason = classifyStderr(
        typeof value === "string" ? value : "",
      );
      if (value instanceof Error) output.filesystemCode = safeCode(value);
    }
  }
  return output;
}

export function logTransportDiagnostic(event, extra, context) {
  // No per-chunk dumps. The surrounding start/terminal/failure events carry
  // counters and timing without storing provider messages or tool payloads.
  if (
    [
      "stream.event",
      "stream.chunk",
      "stream.raw",
      "subprocess.stderr",
    ].includes(event)
  )
    return;
  if (typeof event !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(event))
    return;
  emitDiagnostic("transport." + event, safeTransportFields(extra, context));
}

export async function storageSnapshot(path = "/tmp") {
  let s;
  for (;;) {
    try {
      s = await statfs(path);
      break;
    } catch (error) {
      const parent = dirname(path);
      if (error.code !== "ENOENT" || parent === path) throw error;
      path = parent;
    }
  }
  return {
    totalBytes: s.blocks * s.bsize,
    availableBytes: s.bavail * s.bsize,
    freeInodes: s.ffree,
  };
}

export async function requireStorage(
  path = "/tmp",
  minimumBytes = 32 * 1024 * 1024,
) {
  const snapshot = await storageSnapshot(path);
  if (snapshot.availableBytes < minimumBytes || snapshot.freeInodes === 0) {
    emitDiagnostic("storage.rejected", { ...snapshot, minimumBytes });
    throw new Error("Gateway session storage has insufficient capacity");
  }
  return snapshot;
}

export function classifyStderr(data) {
  const text = String(data).toLowerCase();
  if (/enospc|no space left/.test(text)) return "ENOSPC";
  if (/edquot|disk quota exceeded/.test(text)) return "EDQUOT";
  if (/input\/output error|\beio\b/.test(text)) return "EIO";
  if (/no conversation.*(found|resume)|no conversations found/.test(text))
    return "SESSION_MISSING";
  if (/no message found with message.uuid/.test(text))
    return "CHECKPOINT_MISSING";
  if (/mirror.*(error|fail)|transcript.*(error|fail)/.test(text))
    return "PERSISTENCE_ERROR";
  return "OTHER";
}

export function observeStderr(data, requestId) {
  const reason = classifyStderr(data);
  if (reason !== "OTHER")
    emitDiagnostic("subprocess.failure", {
      request: digest(requestId),
      reason,
    });
}

export async function inspectCheckpoint(file) {
  const before = await stat(file);
  if (!before.isFile() || before.size > 128 * 1024 * 1024)
    return { valid: false, reason: "file_bounds", bytes: before.size };
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let records = 0,
    messages = 0,
    users = 0,
    assistants = 0,
    roots = 0,
    compacted = false;
  let rootId = null;
  let result;
  try {
    for await (const line of lines) {
      if (!line) continue;
      records++;
      if (line.length > 16 * 1024 * 1024 || records > 250_000) {
        result = { valid: false, reason: "record_bounds" };
        break;
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        result = { valid: false, reason: "invalid_json", badLine: records };
        break;
      }
      if (!row || typeof row !== "object") {
        result = { valid: false, reason: "invalid_record", badLine: records };
        break;
      }
      if (row.type === "system" && row.subtype === "compact_boundary")
        compacted = true;
      if (row.type !== "user" && row.type !== "assistant") continue;
      messages++;
      if (row.type === "user") users++;
      else assistants++;
      if (row.parentUuid === null && typeof row.uuid === "string") {
        roots++;
        rootId ??= row.uuid;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const after = await stat(file);
  const metrics = {
    bytes: after.size,
    records,
    messages,
    users,
    assistants,
    roots,
    compacted,
  };
  if (result) return { ...metrics, ...result };
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    return { ...metrics, valid: false, reason: "still_writing" };
  if (!users || !assistants || !roots)
    return { ...metrics, valid: false, reason: "missing_history" };
  return { ...metrics, valid: true, rootId };
}

async function checkpointPath(locator) {
  if (!/^[0-9a-f-]{36}$/i.test(locator.sessionId))
    throw new Error("Invalid checkpoint identity");
  const directory = join(locator.configDir, "projects");
  const projects = await readdir(directory, { withFileTypes: true });
  if (projects.length > 4096) throw new Error("Checkpoint directory limit");
  const candidates = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const file = join(directory, project.name, locator.sessionId + ".jsonl");
    try {
      await stat(file);
      candidates.push(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (candidates.length !== 1)
    throw Object.assign(new Error("Checkpoint not uniquely available"), {
      code: "ENOENT",
    });
  return candidates[0];
}

export async function validateCheckpoint(locator) {
  const session = digest(locator.sessionId);
  let result;
  try {
    result = await inspectCheckpoint(await checkpointPath(locator));
  } catch (error) {
    emitDiagnostic("checkpoint.rejected", {
      session,
      reason: "filesystem",
      code: safeCode(error),
    });
    // Preserve the in-memory cause; diagnostic output above contains only its code.
    throw new Error("Gateway checkpoint persistence failed", {
      cause: error,
    });
  }
  const { rootId, ...metrics } = result;
  let storage;
  try {
    storage = await storageSnapshot(locator.configDir);
  } catch (error) {
    storage = { code: safeCode(error) };
  }
  emitDiagnostic(
    result.valid ? "checkpoint.validated" : "checkpoint.rejected",
    {
      session,
      ...metrics,
      storage,
      ...(rootId ? { root: digest(rootId) } : {}),
    },
  );
  if (!result.valid)
    throw new Error(
      "Gateway checkpoint is incomplete or corrupt; previous session retained",
    );
  return result;
}

export function rejectResumeFallback(requestId, refusal) {
  emitDiagnostic("session.replay_blocked", {
    request: digest(requestId),
    reason: ["busy", "unresumable", "missing-message"].includes(refusal)
      ? refusal
      : "unknown",
  });
  throw new Error(
    "Gateway could not resume the conversation; automatic context-loss replay was blocked",
  );
}

export function startStorageMonitor() {
  let busy = false,
    last = 0,
    bucket = -1;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await storageSnapshot();
      const next = Math.floor(
        (s.availableBytes / Math.max(1, s.totalBytes)) * 100,
      );
      if (next !== bucket || Date.now() - last >= 60_000) {
        emitDiagnostic("storage.sample", s);
        bucket = next;
        last = Date.now();
      }
    } catch (error) {
      emitDiagnostic("storage.monitor_failed", { code: safeCode(error) });
    } finally {
      busy = false;
    }
  };
  void sample();
  const timer = setInterval(sample, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

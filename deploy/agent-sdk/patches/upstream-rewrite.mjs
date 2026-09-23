import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { URL } from "node:url";
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from "node:zlib";

// Loopback rewrite in front of api.anthropic.com for the SDK subprocesses.
//
// The bundled Claude Code CLI appends a "# Environment" system-reminder that
// describes the process it runs in (this container) to the first user turn.
// Clients reached through the gateway already carry their own environment in
// the system prompt, so that reminder is removed, and references to this
// container's Claude Code session files are replaced. Nothing else changes:
// headers, model, metadata, billing header, streaming and status codes are
// forwarded untouched. This module never logs prompt content.

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const ENVIRONMENT_REMINDER =
  /^<system-reminder>\s*# Environment\s*\n\s*You have been invoked in the following environment:/;

export const emit = (event, fields = {}) =>
  process.stderr.write(
    JSON.stringify({
      component: "gateway-upstream",
      event,
      time: new Date().toISOString(),
      ...fields,
    }) + "\n",
  );

/** Remove the SDK's own environment reminder for the given working directory. */
export function stripProxyEnvironment(body, cwd) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages))
    return { body, removed: 0 };
  const marker = "Primary working directory: " + cwd;
  let removed = 0;
  const messages = body.messages.map((message) => {
    if (!message || message.role !== "user" || !Array.isArray(message.content))
      return message;
    const content = message.content.filter((block) => {
      const hit =
        block &&
        block.type === "text" &&
        typeof block.text === "string" &&
        ENVIRONMENT_REMINDER.test(block.text) &&
        block.text.includes(marker);
      if (hit) removed++;
      return !hit;
    });
    if (content.length === message.content.length || content.length === 0)
      return message;
    return { ...message, content };
  });
  return removed
    ? { body: { ...body, messages }, removed }
    : { body, removed: 0 };
}

// Claude Code keeps per-session files (images, persisted results) under
// /tmp/claude-<uid>/<cwd slug>/ in this container. Client tools run on the
// client machine, where those paths do not exist, so the model must not be
// sent a reference it would try to open there.
export const BRIDGE_PATH_PLACEHOLDER =
  "[bridge-local file, not available to tools]";

const bridgePathPattern = (cwd) =>
  new RegExp(
    String.raw`/tmp/claude-\d+/` +
      cwd.replace(/[^A-Za-z0-9]/g, "-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      String.raw`/[^\s"'\x60\])<>}]*`,
    "g",
  );

const pathKind = (text, offset, match) =>
  /\[Image: source: ?$/.test(text.slice(Math.max(0, offset - 17), offset))
    ? "image_source"
    : match.includes("/images/")
      ? "image_dir"
      : "other";

/** Replace references to this container's Claude Code session files. */
export function neutralizeBridgePaths(body, cwd) {
  if (!body || typeof body !== "object") return { body, rewritten: 0 };
  const pattern = bridgePathPattern(cwd);
  const locations = {};
  let rewritten = 0;
  const text = (value, where) =>
    value.replace(pattern, (match, offset) => {
      const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
      const key = `${where}.${pathKind(value, offset, match)}`;
      locations[key] = (locations[key] ?? 0) + 1;
      rewritten++;
      return BRIDGE_PATH_PLACEHOLDER + trailing;
    });
  // A replayed call that tried to open such a path keeps it in its input.
  const input = (value) => {
    if (typeof value === "string") return text(value, "tool_use");
    if (Array.isArray(value)) {
      const next = value.map(input);
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      input(item),
    ]);
    return entries.some(([key, item]) => item !== value[key])
      ? Object.fromEntries(entries)
      : value;
  };
  const blocks = (content, where) => {
    if (typeof content === "string") return text(content, where);
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        const next = text(block.text, where);
        return next === block.text ? block : { ...block, text: next };
      }
      if (block?.type === "tool_result") {
        const next = blocks(block.content, "tool_result");
        return next === block.content ? block : { ...block, content: next };
      }
      if (block?.type === "tool_use") {
        const next = input(block.input);
        return next === block.input ? block : { ...block, input: next };
      }
      return block;
    });
  };
  const system = blocks(body.system, "system");
  const messages = Array.isArray(body.messages)
    ? body.messages.map((message) => {
        const where = message?.role === "assistant" ? "assistant" : "user";
        const content = blocks(message?.content, where);
        return content === message?.content ? message : { ...message, content };
      })
    : body.messages;

  return rewritten
    ? { body: { ...body, system, messages }, rewritten, locations }
    : { body, rewritten: 0 };
}

const isJsonMessages = (req) =>
  req.method === "POST" &&
  /^\/v1\/messages(\?|$)/.test(req.url ?? "") &&
  /^application\/json/i.test(req.headers["content-type"] ?? "") &&
  !req.headers["content-encoding"];

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// Upstream outcome diagnostics. Only structural fields are kept: status,
// Anthropic's request id, model, stop reason and error *type*. Error messages
// and streamed content are never retained.
const ERROR_BODY_LIMIT = 64 * 1024;
const SSE_LINE_LIMIT = 16 * 1024;
// The scan is best effort: past these bounds it stops, forwarding never does.
const SCAN_DECODED_LIMIT = 64 * 1024 * 1024;
const SCAN_BACKLOG_LIMIT = 1024 * 1024;
const TOKEN = /^[\w.:[\]-]{1,96}$/;

const safeToken = (value) =>
  typeof value === "string" && TOKEN.test(value) ? value : undefined;
// Provider-supplied labels are logged only as known values, never verbatim.
const ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
]);
const STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);
const errorTypeOf = (parsed) => {
  const type = parsed?.error?.type;
  if (type === undefined) return "unparsed";
  return ERROR_TYPES.has(type) ? type : "other";
};
const REQUEST_ID = /^req_[A-Za-z0-9]{1,64}$/;
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

const decodeBody = (buffer, encoding) => {
  const bounded = { maxOutputLength: ERROR_BODY_LIMIT };
  switch (String(encoding ?? "").toLowerCase()) {
    case "gzip":
      return gunzipSync(buffer, bounded);
    case "br":
      return brotliDecompressSync(buffer, bounded);
    case "deflate":
      return inflateSync(buffer, bounded);
    default:
      return buffer;
  }
};

// Upstream SSE usually arrives compressed; the scan reads a decompressed copy
// while the original bytes still pass through untouched.
const streamDecoder = (encoding) => {
  switch (String(encoding ?? "identity").toLowerCase()) {
    case "gzip":
      return createGunzip();
    case "br":
      return createBrotliDecompress();
    case "deflate":
      return createInflate();
    default:
      return undefined;
  }
};

/** The `error.type` of an Anthropic JSON error body, never its message. */
export function errorTypeFromBody(buffer, encoding) {
  try {
    const parsed = JSON.parse(decodeBody(buffer, encoding).toString("utf8"));

    return errorTypeOf(parsed);
  } catch {
    return "unparsed";
  }
}

/** Incremental SSE scan that keeps event counts, stop reason and error type. */
export function createStreamScanner() {
  const decoder = new StringDecoder("utf8");
  const summary = {
    events: 0,
    terminal: false,
    stopReason: undefined,
    errorType: undefined,
  };
  let carry = "";
  let skipping = false;
  let errorNext = false;
  const line = (text) => {
    if (text.startsWith("event:")) {
      const name = text.slice(6).trim();

      summary.events += 1;
      if (name === "message_stop") summary.terminal = true;
      errorNext = name === "error";
      return;
    }
    if (!text.startsWith("data:")) return;
    const data = text.slice(5).trimStart();

    if (errorNext) {
      errorNext = false;
      try {
        summary.errorType = errorTypeOf(JSON.parse(data));
      } catch {
        summary.errorType = "unparsed";
      }
      return;
    }
    if (data.startsWith('{"type":"message_delta"')) {
      const stop = /"stop_reason":"([a-z_]{1,32})"/.exec(data);

      if (stop)
        summary.stopReason = STOP_REASONS.has(stop[1]) ? stop[1] : "other";
    }
  };

  return {
    push(chunk) {
      carry += decoder.write(chunk);
      let index;

      while ((index = carry.indexOf("\n")) !== -1) {
        const text = carry.slice(0, index).replace(/\r$/, "");

        carry = carry.slice(index + 1);
        if (skipping) skipping = false;
        else line(text);
      }
      // A long content line carries nothing we keep; drop it until its end.
      if (carry.length > SSE_LINE_LIMIT) {
        carry = "";
        skipping = true;
      }
    },
    summary: () => ({ ...summary }),
  };
}

/** Emit one `upstream.response` per upstream call once it ends or is cut. */
const observeUpstream = (upstreamRes, res, context, startedAt) => {
  const status = upstreamRes.statusCode ?? 0;
  const encoding = upstreamRes.headers["content-encoding"];
  const streaming = /text\/event-stream/i.test(
    upstreamRes.headers["content-type"] ?? "",
  );
  const decoder = streaming ? streamDecoder(encoding) : undefined;
  const identity = !encoding || encoding === "identity";
  const scanner =
    streaming && (identity || decoder) ? createStreamScanner() : undefined;
  let decoded = 0;
  let scanStopped = false;
  const stopScan = () => {
    scanStopped = true;
    decoder.destroy();
  };
  if (decoder) {
    decoder.on("data", (chunk) => {
      decoded += chunk.length;
      if (decoded > SCAN_DECODED_LIMIT) stopScan();
      else scanner.push(chunk);
    });
    // A truncated or corrupt stream ends the scan without scan fields.
    decoder.on("error", () => {
      scanStopped = true;
    });
  }
  const errorChunks = [];
  let errorBytes = 0;
  let bytes = 0;
  let reported = false;

  upstreamRes.on("data", (chunk) => {
    bytes += chunk.length;
    if (decoder) {
      if (decoder.destroyed) return;
      decoder.write(chunk);
      if (decoder.writableLength > SCAN_BACKLOG_LIMIT) stopScan();
    } else if (scanner) scanner.push(chunk);
    else if (status >= 400 && errorBytes < ERROR_BODY_LIMIT) {
      errorChunks.push(chunk);
      errorBytes += chunk.length;
    }
  });
  const report = (closedBy) => {
    if (reported) return;
    reported = true;
    // A stopped scan saw only a prefix, so it reports no scan fields at all.
    const scan = scanStopped ? undefined : scanner?.summary();
    const errorType =
      scan?.errorType ??
      (status >= 400 && !scanner
        ? errorTypeFromBody(Buffer.concat(errorChunks), encoding)
        : undefined);

    emit("upstream.response", {
      ...context,
      status,
      requestId: REQUEST_ID.test(upstreamRes.headers["request-id"] ?? "")
        ? upstreamRes.headers["request-id"]
        : undefined,
      streaming,
      durationMs: Date.now() - startedAt,
      bytes,
      closedBy,
      ...(scan ? { events: scan.events, terminal: scan.terminal } : {}),
      ...(scan?.stopReason ? { stopReason: scan.stopReason } : {}),
      ...(errorType ? { errorType } : {}),
    });
  };

  upstreamRes.on("close", () => {
    const closedBy = upstreamRes.complete ? "upstream_end" : "upstream_aborted";
    if (!decoder || decoder.destroyed) return report(closedBy);
    decoder.once("close", () => report(closedBy));
    decoder.end();
  });
  res.on("close", () => {
    if (!res.writableFinished) report("client_closed");
  });
};

const errorResponse = (res, status, type, message) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
};

export function createRewriteServer({ host, port, upstream, cwd }) {
  const target = new URL(upstream);
  const secure = target.protocol === "https:";
  const transport = secure ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 64 });
  const forward = (req, res, body, model) => {
    const startedAt = Date.now();
    const sessionHeader = req.headers["x-claude-code-session-id"];
    const context = {
      method: req.method,
      path: (req.url ?? "").split("?")[0].slice(0, 128),
      ...(safeToken(model) ? { model } : {}),
      ...(sessionHeader ? { session: digest(sessionHeader) } : {}),
    };
    const headers = { ...req.headers, host: target.host };
    if (body !== undefined) headers["content-length"] = String(body.length);
    const up = transport.request(
      {
        agent,
        host: target.hostname,
        port: target.port || (secure ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        observeUpstream(upstreamRes, res, context, startedAt);
        upstreamRes.pipe(res);
      },
    );
    up.on("error", (error) => {
      emit("upstream.error", {
        ...context,
        code: error?.code ?? "UNKNOWN",
        durationMs: Date.now() - startedAt,
      });
      errorResponse(res, 502, "api_error", "Upstream request failed");
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body !== undefined) up.end(body);
    else req.pipe(up);
  };
  const server = http.createServer(async (req, res) => {
    if (!isJsonMessages(req)) return forward(req, res);
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      emit("request.read_failed", { code: error?.code ?? "UNKNOWN" });
      return errorResponse(
        res,
        413,
        "invalid_request_error",
        "Request too large",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return forward(req, res, raw);
    }
    const stripped = stripProxyEnvironment(parsed, cwd);
    const { body, rewritten, locations } = neutralizeBridgePaths(
      stripped.body,
      cwd,
    );
    if (stripped.removed)
      emit("environment.stripped", { removed: stripped.removed });
    if (rewritten) emit("bridge_path.neutralized", { rewritten, locations });
    forward(
      req,
      res,
      stripped.removed || rewritten ? Buffer.from(JSON.stringify(body)) : raw,
      parsed?.model,
    );
  });
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      emit("listening", { port, secure });
      resolve(server);
    });
  });
}

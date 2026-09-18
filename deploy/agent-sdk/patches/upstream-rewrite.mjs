import { Buffer } from "node:buffer";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import { URL } from "node:url";

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
      String.raw`/[^\s"'\x60\])>]*`,
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
  const forward = (req, res, body) => {
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
        upstreamRes.pipe(res);
      },
    );
    up.on("error", (error) => {
      emit("upstream.error", { code: error?.code ?? "UNKNOWN" });
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

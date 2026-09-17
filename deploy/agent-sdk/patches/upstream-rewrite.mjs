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
// the system prompt, so that reminder is removed. Nothing else changes:
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
    const { body, removed } = stripProxyEnvironment(parsed, cwd);
    if (removed) emit("environment.stripped", { removed });
    forward(req, res, removed ? Buffer.from(JSON.stringify(body)) : raw);
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

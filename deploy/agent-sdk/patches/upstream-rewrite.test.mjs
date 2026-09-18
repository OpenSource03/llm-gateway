import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import http from "node:http";
import { setTimeout } from "node:timers";

const { fetch } = globalThis;
import test from "node:test";
import {
  BRIDGE_PATH_PLACEHOLDER,
  createRewriteServer,
  neutralizeBridgePaths,
  stripProxyEnvironment,
} from "./upstream-rewrite.mjs";

const reminder = (cwd) => ({
  type: "text",
  text:
    "<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: " +
    cwd +
    "\n - Is a git repository: false\n - Platform: linux\n - Shell: unknown\n - OS Version: Linux 6.6.0\n</system-reminder>",
});
const clientBody = () => ({
  model: "claude-haiku-4-5-20251001",
  system: [
    {
      type: "text",
      text: "# Environment\n - Primary working directory: /Users/tester\n - Platform: darwin",
    },
  ],
  messages: [
    {
      role: "user",
      content: [
        reminder("/opt/meridian"),
        {
          type: "text",
          text: "<system-reminder>\nToday's date is 2026-09-17.\n</system-reminder>",
        },
        {
          type: "text",
          text: "Say OK",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "OK" }] },
    { role: "user", content: "again" },
  ],
  metadata: { user_id: "x" },
});

test("removes only the SDK environment reminder for the proxy cwd", () => {
  const { body, removed } = stripProxyEnvironment(
    clientBody(),
    "/opt/meridian",
  );
  assert.equal(removed, 1);
  assert.equal(body.messages[0].content.length, 2);
  assert.equal(
    body.messages[0].content[0].text.startsWith("<system-reminder>\nToday"),
    true,
  );
  assert.deepEqual(body.messages[0].content[1].cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
  assert.equal(body.messages[2].content, "again");
  assert.deepEqual(body.system, clientBody().system);
  assert.deepEqual(body.metadata, { user_id: "x" });
});

test("leaves a client environment reminder for another directory alone", () => {
  const input = clientBody();
  input.messages[0].content[0] = reminder("/Users/tester/project");
  const { body, removed } = stripProxyEnvironment(input, "/opt/meridian");
  assert.equal(removed, 0);
  assert.equal(body, input);
  assert.equal(
    stripProxyEnvironment({ model: "m" }, "/opt/meridian").removed,
    0,
  );
  assert.equal(stripProxyEnvironment(null, "/opt/meridian").removed, 0);
  const only = {
    messages: [{ role: "user", content: [reminder("/opt/meridian")] }],
  };
  assert.equal(
    stripProxyEnvironment(only, "/opt/meridian").body.messages[0].content
      .length,
    1,
  );
});

test("forwards headers and streams untouched while rewriting the messages body", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      seen.push({ url: req.url, headers: req.headers, raw });
      if (req.url.startsWith("/v1/messages")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-upstream": "yes",
        });
        res.write("event: a\ndata: {}\n\n");
        setTimeout(() => res.end("event: b\ndata: {}\n\n"), 20);
      } else {
        res.writeHead(204, { "x-upstream": "hello" });
        res.end();
      }
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const server = await createRewriteServer({
    host: "127.0.0.1",
    port: 0,
    upstream: "http://127.0.0.1:" + upstream.address().port,
    cwd: "/opt/meridian",
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const head = await fetch(base + "/api/hello", {
      method: "HEAD",
      headers: { "user-agent": "Bun/1.4.3" },
    });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get("x-upstream"), "hello");
    const response = await fetch(base + "/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "user-agent": "claude-cli/2.1.272 (external, sdk-ts)",
        "x-app": "cli",
      },
      body: JSON.stringify(clientBody()),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream"), "yes");
    assert.equal(
      await response.text(),
      "event: a\ndata: {}\n\nevent: b\ndata: {}\n\n",
    );
    const call = seen.find((s) => s.url === "/v1/messages?beta=true");
    assert.equal(call.headers.authorization, "Bearer secret");
    assert.equal(
      call.headers["anthropic-beta"],
      "oauth-2025-04-20,claude-code-20250219",
    );
    assert.equal(
      call.headers["user-agent"],
      "claude-cli/2.1.272 (external, sdk-ts)",
    );
    assert.equal(call.headers["x-app"], "cli");
    assert.equal(call.headers["content-length"], String(call.raw.length));
    const forwarded = JSON.parse(call.raw.toString("utf8"));
    assert.equal(forwarded.messages[0].content.length, 2);
    assert.equal(JSON.stringify(forwarded).includes("/opt/meridian"), false);
    // Non-JSON or already-encoded bodies pass through byte for byte.
    const raw = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "not-json",
    });
    await raw.text();
    assert.equal(seen.at(-1).raw.toString(), "not-json");
  } finally {
    server.close();
    upstream.close();
  }
});

const session =
  "/tmp/claude-1000/-opt-meridian/ecd35f51-d18e-4c97-a9bf-fb3aa19f8bf5";

test("replaces references to the bridge's own session files", () => {
  const signed = { type: "thinking", thinking: session, signature: "sig" };
  const input = {
    system: `Scratch space: ${session}/scratchpad`,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `[Image: source: ${session}/images/1.png]` },
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: `saved to ${session}/images/2.png.` },
            ],
          },
          {
            type: "text",
            text: "Client file /tmp/claude-501/-Users-me/x/a.png",
          },
        ],
      },
      {
        role: "assistant",
        content: [signed, { type: "text", text: `see ${session}/images/` }],
      },
    ],
  };
  const { body, rewritten, locations } = neutralizeBridgePaths(
    input,
    "/opt/meridian",
  );

  assert.equal(rewritten, 4);
  assert.deepEqual(locations, {
    "system.other": 1,
    "user.image_source": 1,
    "tool_result.image_dir": 1,
    "assistant.image_dir": 1,
  });
  assert.equal(body.system, `Scratch space: ${BRIDGE_PATH_PLACEHOLDER}`);
  assert.equal(
    body.messages[0].content[0].text,
    `[Image: source: ${BRIDGE_PATH_PLACEHOLDER}]`,
  );
  assert.equal(
    body.messages[0].content[1].content[0].text,
    `saved to ${BRIDGE_PATH_PLACEHOLDER}.`,
  );
  assert.equal(
    body.messages[0].content[2].text,
    "Client file /tmp/claude-501/-Users-me/x/a.png",
  );
  assert.equal(body.messages[1].content[0], signed);
  assert.equal(
    JSON.stringify(body).includes("claude-1000/-opt-meridian/ecd35f51"),
    true,
  );
  assert.equal(JSON.stringify(input.messages[0]).includes(session), true);
});

test("returns the original body when no bridge path is present", () => {
  const input = clientBody();
  const result = neutralizeBridgePaths(input, "/opt/meridian");
  assert.equal(result.rewritten, 0);
  assert.equal(result.body, input);
  assert.equal(neutralizeBridgePaths(null, "/opt/meridian").rewritten, 0);
});

test("scrubs bridge paths from replayed tool calls and keeps closing braces", () => {
  const call = {
    type: "tool_use",
    id: "t9",
    name: "exec",
    input: { cmd: `ls -la ${session}/images/`, env: { keep: "x" }, n: 1 },
  };
  const { body, rewritten, locations } = neutralizeBridgePaths(
    {
      messages: [
        { role: "assistant", content: [call] },
        { role: "user", content: `open ${session}/images/1.png}` },
      ],
    },
    "/opt/meridian",
  );

  assert.equal(rewritten, 2);
  assert.deepEqual(locations, { "tool_use.image_dir": 1, "user.image_dir": 1 });
  assert.equal(
    body.messages[0].content[0].input.cmd,
    `ls -la ${BRIDGE_PATH_PLACEHOLDER}`,
  );
  assert.equal(body.messages[0].content[0].input.env, call.input.env);
  assert.equal(body.messages[0].content[0].id, "t9");
  assert.equal(body.messages[1].content, `open ${BRIDGE_PATH_PLACEHOLDER}}`);
  assert.equal(
    neutralizeBridgePaths(
      {
        messages: [
          { role: "user", content: `<img>${session}/images/1.png</img>` },
        ],
      },
      "/opt/meridian",
    ).body.messages[0].content,
    `<img>${BRIDGE_PATH_PLACEHOLDER}</img>`,
  );
});

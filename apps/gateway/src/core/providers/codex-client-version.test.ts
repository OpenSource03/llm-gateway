import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEWED_CODEX_CLIENT_VERSION,
  acceptedCodexClientVersion,
  createCodexClientVersionSource,
} from "./codex-client-version";

const HOUR = 60 * 60_000;

const registry = (responses: Array<Response | Error>) => {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;

    calls += 1;
    if (next instanceof Error) throw next;

    return next.clone();
  }) as typeof fetch;

  return { fetch: fetchImpl, calls: () => calls };
};

const release = (version: unknown) =>
  new Response(JSON.stringify({ name: "@openai/codex", version }), {
    headers: { "content-type": "application/json" },
  });

test("follows a newer release of the reviewed major version only", () => {
  const accept = (current: string, candidate: string) =>
    acceptedCodexClientVersion("0.157.0", current, candidate);

  assert.equal(accept("0.157.0", "0.158.1"), "0.158.1");
  assert.equal(accept("0.157.0", "0.157.3"), "0.157.3");
  assert.equal(accept("0.157.0", "0.156.9"), "0.157.0");
  assert.equal(accept("0.157.0", "1.0.0"), "0.157.0");
  assert.equal(accept("0.157.0", "0.159.0-alpha.1"), "0.157.0");
  assert.equal(accept("0.157.0", ""), "0.157.0");
  // Never moves backwards, and a new major keeps the followed version.
  assert.equal(accept("0.158.0", "0.157.5"), "0.158.0");
  assert.equal(accept("0.158.0", "1.0.0"), "0.158.0");
});

test("a new major release after a followed one keeps the followed version", async () => {
  let now = 0;
  const mock = registry([release("0.158.0"), release("1.0.0")]);
  const source = createCodexClientVersionSource({
    fetch: mock.fetch,
    now: () => now,
    setting: "auto",
  });

  assert.equal(await source.refresh(), "0.158.0");
  now += 7 * HOUR;
  assert.equal(await source.refresh(), "0.158.0");
  assert.equal(mock.calls(), 2);
});

test("current() starts a due lookup in the background without waiting", async () => {
  const mock = registry([release("0.158.0")]);
  const source = createCodexClientVersionSource({
    fetch: mock.fetch,
    now: () => 0,
    setting: "auto",
  });

  assert.equal(source.current(), REVIEWED_CODEX_CLIENT_VERSION);
  assert.equal(mock.calls(), 1);
  assert.equal(await source.refresh(), "0.158.0");
  assert.equal(source.current(), "0.158.0");
  assert.equal(mock.calls(), 1);
});

test("the same-major rule uses the reviewed version's major", () => {
  assert.equal(acceptedCodexClientVersion("1.2.0", "1.2.0", "1.3.0"), "1.3.0");
});

test("looks up the release once, then again after six hours", async () => {
  let now = 0;
  const mock = registry([release("0.158.0"), release("0.159.0")]);
  const source = createCodexClientVersionSource({
    fetch: mock.fetch,
    now: () => now,
    setting: "auto",
  });

  assert.equal(source.current(), REVIEWED_CODEX_CLIENT_VERSION);
  assert.deepEqual(await Promise.all([source.refresh(), source.refresh()]), [
    "0.158.0",
    "0.158.0",
  ]);
  assert.equal(mock.calls(), 1);
  now += 5 * HOUR;
  assert.equal(await source.refresh(), "0.158.0");
  assert.equal(mock.calls(), 1);
  now += 2 * HOUR;
  assert.equal(await source.refresh(), "0.159.0");
  assert.equal(source.current(), "0.159.0");
  assert.equal(mock.calls(), 2);
});

test("keeps the current version when the registry fails, and retries later", async () => {
  let now = 0;
  const mock = registry([
    new TypeError("fetch failed"),
    new Response("unavailable", { status: 503 }),
    release({ not: "a version" }),
    release("0.158.0"),
  ]);
  const source = createCodexClientVersionSource({
    fetch: mock.fetch,
    now: () => now,
    setting: "auto",
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await source.refresh(), REVIEWED_CODEX_CLIENT_VERSION);
    assert.equal(await source.refresh(), REVIEWED_CODEX_CLIENT_VERSION);
    now += 16 * 60_000;
  }
  assert.equal(await source.refresh(), "0.158.0");
  assert.equal(mock.calls(), 4);
});

test("a pinned version never looks anything up", async () => {
  const mock = registry([release("0.200.0")]);
  const source = createCodexClientVersionSource({
    fetch: mock.fetch,
    now: () => 0,
    setting: "0.155.0",
  });

  assert.equal(await source.refresh(), "0.155.0");
  assert.equal(source.current(), "0.155.0");
  assert.equal(mock.calls(), 0);
});

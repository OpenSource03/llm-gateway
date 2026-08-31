import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCodexSearchRequest,
  parseCodexSearchResponse,
} from "./codex-search";

test("Codex search parser preserves the forward-compatible search envelope", () => {
  const request = parseCodexSearchRequest({
    id: "search-id",
    model: "anthropic/claude-opus-5",
    input: [{ type: "message", role: "user", content: [] }],
    commands: { search_query: [{ q: "Codex" }] },
    settings: { external_web_access: true },
    max_output_tokens: 512,
  });

  assert.deepEqual(request, {
    id: "search-id",
    model: "anthropic/claude-opus-5",
    input: [{ type: "message", role: "user", content: [] }],
    commands: { search_query: [{ q: "Codex" }] },
    settings: { external_web_access: true },
    max_output_tokens: 512,
  });
});

test("Codex search parser rejects unknown envelope fields", () => {
  assert.throws(
    () =>
      parseCodexSearchRequest({
        id: "search-id",
        model: "gpt-5",
        commands: {},
        unexpected: true,
      }),
    /request\.unexpected is not supported/,
  );
});

test("Codex search parser bounds search output tokens", () => {
  assert.throws(
    () =>
      parseCodexSearchRequest({
        id: "search-id",
        model: "gpt-5",
        max_output_tokens: 0,
      }),
    /max_output_tokens is invalid/,
  );
});

test("Codex search response preserves the native envelope and opaque results", () => {
  assert.deepEqual(
    parseCodexSearchResponse({
      encrypted_output: "ciphertext",
      output: "Search result",
      results: [{ type: "future_result", future_field: true }],
      provider_internal_field: "drop",
    }),
    {
      encrypted_output: "ciphertext",
      output: "Search result",
      results: [{ type: "future_result", future_field: true }],
    },
  );
});

test("Codex search response requires the fields decoded by the client", () => {
  assert.throws(
    () => parseCodexSearchResponse({ output: "missing ciphertext field" }),
    /encrypted_output is invalid/,
  );
  assert.throws(
    () => parseCodexSearchResponse({ encrypted_output: null, output: 42 }),
    /output is invalid/,
  );
  assert.throws(
    () =>
      parseCodexSearchResponse({
        encrypted_output: null,
        output: "result",
        results: {},
      }),
    /results are invalid/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_MCP_TOOL_NAME_LIMIT,
  claudeCodeMcpToolName,
  claudeCodeWireToolName,
} from "./claude-code-tool-name";

const toolSegment = (wireName: string): string =>
  wireName.split("__").slice(2).join("__");

test("Claude MCP names match native semantic qualification", () => {
  assert.equal(
    claudeCodeMcpToolName("read.file", "project tools"),
    "mcp__project_tools__read.file",
  );
  assert.equal(
    claudeCodeWireToolName("mcp__project tools__read.file"),
    "mcp__project_tools__read.file",
  );
  assert.equal(claudeCodeWireToolName("shell"), "mcp__codex__shell");
});

test("Claude MCP tool segments are bounded and collision-safe", () => {
  const longName = "read_".repeat(30);
  const first = claudeCodeMcpToolName(longName, "capture");
  const second = claudeCodeMcpToolName(longName, "capture", 1);

  assert.equal(toolSegment(first).length, CLAUDE_CODE_MCP_TOOL_NAME_LIMIT);
  assert.equal(toolSegment(second).length, CLAUDE_CODE_MCP_TOOL_NAME_LIMIT);
  assert.match(first, /_[0-9a-f]{12}$/);
  assert.match(second, /_[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test("Claude MCP collision attempts disambiguate normalized spellings", () => {
  const first = claudeCodeMcpToolName("read/file", "capture");
  const second = claudeCodeMcpToolName("read?file", "capture", 1);

  assert.equal(first, "mcp__capture__read_file");
  assert.match(second, /^mcp__capture__read_file_[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

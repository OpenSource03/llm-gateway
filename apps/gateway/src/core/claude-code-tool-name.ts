import { createHash } from "node:crypto";

/**
 * Claude Code 2.1.247 accepts MCP tool names up to 128 characters. Its
 * provider-facing name keeps the tool spelling and only normalizes the server
 * segment before composing `mcp__<server>__<tool>`.
 */
export const CLAUDE_CODE_MCP_TOOL_NAME_LIMIT = 128;

const INVALID_SERVER_CHARACTER = /[^A-Za-z0-9_-]/g;
const INVALID_TOOL_CHARACTER = /[^A-Za-z0-9._-]/g;

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const normalizedServerName = (value: string): string =>
  value.replace(INVALID_SERVER_CHARACTER, "_") || "codex";

const normalizedToolName = (value: string): string =>
  value.replace(INVALID_TOOL_CHARACTER, "_") || "tool";

const boundedToolName = (
  name: string,
  identity: string,
  collisionAttempt: number,
): string => {
  const collisionSuffix =
    collisionAttempt > 0
      ? `_${shortHash(`${identity}\0${collisionAttempt}`)}`
      : "";
  const candidate = `${name}${collisionSuffix}`;

  if (candidate.length <= CLAUDE_CODE_MCP_TOOL_NAME_LIMIT) return candidate;
  const truncationSuffix = `_${shortHash(
    collisionAttempt > 0 ? `${identity}\0${collisionAttempt}` : identity,
  )}`;

  return `${name.slice(
    0,
    CLAUDE_CODE_MCP_TOOL_NAME_LIMIT - truncationSuffix.length,
  )}${truncationSuffix}`;
};

/**
 * Construct the semantic name Claude Code uses for an MCP tool. The optional
 * collision attempt is used only when two distinct public identities normalize
 * to the same wire name; it remains deterministic and within the native raw
 * MCP tool-name limit.
 */
export function claudeCodeMcpToolName(
  name: string,
  namespace = "codex",
  collisionAttempt = 0,
): string {
  const identity = `${namespace}\0${name}`;
  const tool = boundedToolName(
    normalizedToolName(name),
    identity,
    collisionAttempt,
  );

  return `mcp__${normalizedServerName(namespace)}__${tool}`;
}

/** Preserve the structure of native MCP names; qualify portable tools. */
export function claudeCodeWireToolName(name: string): string {
  if (!name.startsWith("mcp__")) return claudeCodeMcpToolName(name);
  const [server, ...tool] = name.slice("mcp__".length).split("__");

  if (!server || tool.length === 0) return claudeCodeMcpToolName(name);

  return claudeCodeMcpToolName(tool.join("__"), server);
}

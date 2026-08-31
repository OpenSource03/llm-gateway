import {
  JSON_MAX_STRING_LENGTH,
  assertAllowedKeys,
  assertBoundedJsonValue,
  isRecord,
} from "./validation";

/**
 * Codex's standalone search payload is intentionally kept opaque below the
 * top-level contract. The `input`, `commands`, and `settings` objects evolve
 * with the Codex client; validating them as bounded JSON preserves forward
 * compatibility without allowing the gateway to accept an arbitrary request
 * envelope or an upstream URL.
 */
export interface CodexSearchRequest {
  id: string;
  model: string;
  reasoning?: Record<string, unknown>;
  input?: string | Array<Record<string, unknown>>;
  commands?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  max_output_tokens?: number;
}

export interface CodexSearchResponse {
  encrypted_output: string | null;
  output: string;
  results?: unknown[] | null;
}

const TOP_LEVEL_KEYS = [
  "id",
  "model",
  "reasoning",
  "input",
  "commands",
  "settings",
  "max_output_tokens",
] as const;

const MAX_SEARCH_INPUT_ITEMS = 10_000;
const MAX_SEARCH_OUTPUT_TOKENS = 128_000;

const boundedString = (
  value: unknown,
  path: string,
  max = JSON_MAX_STRING_LENGTH,
): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }

  return value;
};

const boundedRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  assertBoundedJsonValue(value, path);

  return value;
};

export function parseCodexSearchRequest(value: unknown): CodexSearchRequest {
  if (!isRecord(value)) throw new TypeError("Request must be an object");
  assertAllowedKeys(value, "request", TOP_LEVEL_KEYS);
  assertBoundedJsonValue(value, "request");

  const id = boundedString(value.id, "id", 256);
  const model = boundedString(value.model, "model", 256);
  const reasoning =
    value.reasoning === undefined
      ? undefined
      : boundedRecord(value.reasoning, "reasoning");
  const input = (() => {
    if (value.input === undefined) return undefined;
    if (typeof value.input === "string")
      return boundedString(value.input, "input");
    if (!Array.isArray(value.input))
      throw new TypeError("input must be a string or array");
    if (value.input.length > MAX_SEARCH_INPUT_ITEMS)
      throw new TypeError("input contains too many entries");

    return value.input.map((item, index) =>
      boundedRecord(item, `input[${index}]`),
    );
  })();
  const commands =
    value.commands === undefined
      ? undefined
      : boundedRecord(value.commands, "commands");
  const settings =
    value.settings === undefined
      ? undefined
      : boundedRecord(value.settings, "settings");
  let maxOutputTokens: number | undefined;

  if (value.max_output_tokens !== undefined) {
    if (
      typeof value.max_output_tokens !== "number" ||
      !Number.isSafeInteger(value.max_output_tokens) ||
      value.max_output_tokens < 1 ||
      value.max_output_tokens > MAX_SEARCH_OUTPUT_TOKENS
    ) {
      throw new TypeError("max_output_tokens is invalid");
    }
    maxOutputTokens = value.max_output_tokens;
  }

  return {
    id,
    model,
    ...(reasoning ? { reasoning } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(commands ? { commands } : {}),
    ...(settings ? { settings } : {}),
    ...(maxOutputTokens !== undefined
      ? { max_output_tokens: maxOutputTokens }
      : {}),
  };
}

/** Reconstruct only the fields consumed by Codex; result DTOs stay opaque. */
export function parseCodexSearchResponse(value: unknown): CodexSearchResponse {
  if (!isRecord(value))
    throw new TypeError("Web-search response must be an object");
  assertBoundedJsonValue(value, "web-search response");

  if (
    value.encrypted_output !== null &&
    typeof value.encrypted_output !== "string"
  ) {
    throw new TypeError("Web-search response encrypted_output is invalid");
  }
  if (typeof value.output !== "string") {
    throw new TypeError("Web-search response output is invalid");
  }
  if (
    value.results !== undefined &&
    value.results !== null &&
    !Array.isArray(value.results)
  ) {
    throw new TypeError("Web-search response results are invalid");
  }

  return {
    encrypted_output: value.encrypted_output,
    output: value.output,
    ...(value.results !== undefined
      ? { results: value.results as unknown[] | null }
      : {}),
  };
}

const JSON_MAX_DEPTH = 40;
const JSON_MAX_NODES = 50_000;
const JSON_MAX_KEYS_PER_OBJECT = 5_000;

export const JSON_MAX_STRING_LENGTH = 2 * 1024 * 1024;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const assertAllowedKeys = (
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void => {
  const allowlist = new Set(allowed);

  for (const key of Object.keys(value)) {
    if (!allowlist.has(key))
      throw new TypeError(`${path}.${key} is not supported by this gateway`);
  }
};

export const assertBoundedJsonValue = (value: unknown, path: string): void => {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > JSON_MAX_NODES)
      throw new TypeError(`${path} contains too many values`);
    if (depth > JSON_MAX_DEPTH)
      throw new TypeError(`${path} is nested too deeply`);
    if (typeof current === "string") {
      if (current.length > JSON_MAX_STRING_LENGTH)
        throw new TypeError(`${path} contains an oversized string`);

      return;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);

      return;
    }
    if (isRecord(current)) {
      const entries = Object.entries(current);

      if (entries.length > JSON_MAX_KEYS_PER_OBJECT)
        throw new TypeError(`${path} contains too many object keys`);
      for (const [key, item] of entries) {
        if (key.length > 1_000)
          throw new TypeError(`${path} contains an oversized object key`);
        visit(item, depth + 1);
      }

      return;
    }
    throw new TypeError(`${path} contains a non-JSON value`);
  };

  visit(value, 0);
};

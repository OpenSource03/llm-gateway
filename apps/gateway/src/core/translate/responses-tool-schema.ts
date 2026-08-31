const SCHEMA_NAME_BAGS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const LITERAL_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

const defineEntry = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

/**
 * Codex annotates some Responses-only collaboration schemas with
 * `encrypted: true`. That keyword is not part of the downstream provider's
 * JSON Schema contract. Remove it from schema positions without deleting a
 * property/definition literally named `encrypted` or an encrypted-shaped
 * literal value.
 *
 * The request validator bounds the tree before this function runs. An
 * explicit stack keeps this helper safe if it is reused independently later.
 */
export function stripResponsesEncryptedSchemaMarker(node: unknown): unknown {
  type Assignment = (value: unknown) => void;
  interface Frame {
    assign: Assignment;
    inNameBag: boolean;
    literal?: boolean;
    node: unknown;
  }

  let result: unknown;
  const stack: Frame[] = [
    { assign: (value) => (result = value), inNameBag: false, node },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.literal) {
      frame.assign(frame.node);
      continue;
    }

    if (Array.isArray(frame.node)) {
      const output = new Array<unknown>(frame.node.length);

      frame.assign(output);
      for (let index = frame.node.length - 1; index >= 0; index -= 1) {
        stack.push({
          assign: (value) => (output[index] = value),
          inNameBag: false,
          node: frame.node[index],
        });
      }
      continue;
    }
    if (
      frame.node === null ||
      typeof frame.node !== "object" ||
      Array.isArray(frame.node)
    ) {
      frame.assign(frame.node);
      continue;
    }
    const output: Record<string, unknown> = {};

    frame.assign(output);
    const entries = Object.entries(frame.node as Record<string, unknown>);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;

      if (!frame.inNameBag && key === "encrypted") continue;
      stack.push({
        assign: (next) => defineEntry(output, key, next),
        inNameBag: !frame.inNameBag && SCHEMA_NAME_BAGS.has(key),
        literal: !frame.inNameBag && LITERAL_VALUE_KEYS.has(key),
        node: value,
      });
    }
  }

  return result;
}

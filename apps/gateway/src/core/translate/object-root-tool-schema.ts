import { stripResponsesEncryptedSchemaMarker } from "./responses-tool-schema";

const TOP_LEVEL_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

type Combinator = (typeof TOP_LEVEL_COMBINATORS)[number];
type JsonSchema = Record<string, unknown>;

const asSchema = (value: unknown): JsonSchema | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;

const propertiesOf = (schema: JsonSchema): Record<string, unknown> =>
  asSchema(schema.properties) ?? {};

const requiredOf = (schema: JsonSchema): Set<string> =>
  new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );

const schemasMatch = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const combinePropertySchemas = (
  current: unknown,
  next: unknown,
  combinator: Combinator,
): unknown => {
  if (schemasMatch(current, next)) return current;

  return { [combinator]: [current, next] };
};

const combineProperties = (
  schemas: JsonSchema[],
  combinator: Combinator,
): Record<string, unknown> => {
  const combined: Record<string, unknown> = {};

  for (const schema of schemas) {
    for (const [name, propertySchema] of Object.entries(propertiesOf(schema))) {
      combined[name] = Object.hasOwn(combined, name)
        ? combinePropertySchemas(combined[name], propertySchema, combinator)
        : propertySchema;
    }
  }

  return combined;
};

const combineRequired = (
  schemas: JsonSchema[],
  combinator: Combinator,
): string[] => {
  if (schemas.length === 0) return [];
  const requiredSets = schemas.map(requiredOf);

  if (combinator === "allOf") {
    return [...new Set(requiredSets.flatMap((required) => [...required]))];
  }

  return [...requiredSets[0]].filter((name) =>
    requiredSets.slice(1).every((required) => required.has(name)),
  );
};

const combineAdditionalProperties = (
  schemas: JsonSchema[],
  combinator: Combinator,
): boolean | undefined => {
  const values = schemas
    .map((schema) => schema.additionalProperties)
    .filter((value): value is boolean => typeof value === "boolean");

  if (values.length === 0) return undefined;
  if (combinator === "allOf") return !values.includes(false);

  return values.length === schemas.length && values.every((value) => !value)
    ? false
    : undefined;
};

const combinationShape = (
  branches: unknown,
  combinator: Combinator,
): JsonSchema | null => {
  if (!Array.isArray(branches)) return null;
  const schemas = branches
    .map(asSchema)
    .filter((schema): schema is JsonSchema => schema !== null)
    .map(normalizeObjectRootToolInputSchema);

  if (schemas.length === 0) return null;
  const properties = combineProperties(schemas, combinator);
  const required = combineRequired(schemas, combinator);
  const additionalProperties = combineAdditionalProperties(schemas, combinator);

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
};

const mergeConjoinedShape = (
  base: JsonSchema,
  shape: JsonSchema,
): JsonSchema => {
  const properties = combineProperties([base, shape], "allOf");
  const required = combineRequired([base, shape], "allOf");
  const additionalProperties = combineAdditionalProperties(
    [base, shape],
    "allOf",
  );

  return {
    ...base,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
};

/**
 * Some subscription transports accept JSON Schema inside a function tool but
 * require the schema root to be an object without root-level composition.
 * Project those branches into one object shape while retaining conflicting
 * property constraints as nested combinators.
 */
export function normalizeObjectRootToolInputSchema(
  schema: unknown,
): JsonSchema {
  const stripped = stripResponsesEncryptedSchemaMarker(schema);
  const source = asSchema(stripped) ?? {};
  const hasTopLevelCombinator = TOP_LEVEL_COMBINATORS.some((key) =>
    Array.isArray(source[key]),
  );

  if (!hasTopLevelCombinator) {
    return {
      ...source,
      type: "object",
      properties: propertiesOf(source),
    };
  }
  let normalized: JsonSchema = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !TOP_LEVEL_COMBINATORS.includes(key as Combinator),
    ),
  );

  normalized.type = "object";
  normalized.properties = propertiesOf(normalized);
  for (const combinator of TOP_LEVEL_COMBINATORS) {
    const shape = combinationShape(source[combinator], combinator);

    if (shape) normalized = mergeConjoinedShape(normalized, shape);
  }

  return normalized;
}

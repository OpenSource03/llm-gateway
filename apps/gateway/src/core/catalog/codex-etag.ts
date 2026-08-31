import { createHash } from "node:crypto";

/** Strong ETag over every client-visible catalog field. */
export function codexCatalogEtag(
  models: ReadonlyArray<Record<string, unknown>>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("base64url");

  return `"arcgw-${digest}"`;
}

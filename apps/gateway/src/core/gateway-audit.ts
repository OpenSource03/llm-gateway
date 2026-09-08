import type { ControlVariables } from "../middleware/control-principal";

import { createMiddleware } from "hono/factory";

import Logger from "../config/logger";

import { llmGatewayPrisma } from "./db";

export interface GatewayAuditRoutePattern {
  methods: string[];
  /** Path relative to `/admin/v1`. */
  match: RegExp;
  action: string;
  entityType: string;
  /** OAuth completion bodies are never captured, even after redaction. */
  captureBody: boolean;
}

const p = (
  methods: string[],
  match: RegExp,
  action: string,
  entityType: string,
  captureBody = true,
): GatewayAuditRoutePattern => ({
  methods,
  match,
  action,
  entityType,
  captureBody,
});

/**
 * Ordered, first match wins. Named `id` groups identify the primary affected
 * entity. Keep nested/specific routes before their generic parents.
 */
export const GATEWAY_AUDIT_ROUTE_PATTERNS: GatewayAuditRoutePattern[] = [
  p(
    ["POST"],
    /^\/accounts\/oauth-tokens$/,
    "llm-gateway.account.create-token",
    "provider-account",
    false,
  ),
  p(
    ["POST"],
    /^\/oauth-attempts\/[^/]+\/poll$/,
    "llm-gateway.oauth.poll",
    "oauth-attempt",
    false,
  ),
  p(
    ["POST"],
    /^\/oauth-attempts\/[^/]+\/complete$/,
    "llm-gateway.oauth.complete",
    "oauth-attempt",
    false,
  ),
  p(
    ["POST"],
    /^\/oauth-attempts$/,
    "llm-gateway.oauth.start",
    "oauth-attempt",
    false,
  ),
  p(
    ["POST"],
    /^\/accounts\/external-profiles$/,
    "llm-gateway.external-profile.link",
    "provider-account",
  ),
  p(
    ["POST"],
    /^\/accounts\/(?<id>[^/]+)\/verify-access$/,
    "llm-gateway.account.verify-access",
    "provider-account",
    false,
  ),
  p(
    ["POST"],
    /^\/accounts\/(?<id>[^/]+)\/refresh$/,
    "llm-gateway.account.refresh",
    "provider-account",
  ),
  p(
    ["PATCH"],
    /^\/accounts\/(?<id>[^/]+)$/,
    "llm-gateway.account.update",
    "provider-account",
  ),
  p(
    ["DELETE"],
    /^\/accounts\/(?<id>[^/]+)$/,
    "llm-gateway.account.delete",
    "provider-account",
  ),
  p(
    ["POST"],
    /^\/models\/refresh$/,
    "llm-gateway.models.refresh",
    "model-catalog",
  ),
  p(["PATCH"], /^\/models\/(?<id>[^/]+)$/, "llm-gateway.model.update", "model"),
  p(
    ["POST"],
    /^\/routing-pools\/(?<poolId>[^/]+)\/members$/,
    "llm-gateway.routing-member.create",
    "routing-member",
  ),
  p(
    ["PATCH"],
    /^\/routing-pools\/[^/]+\/members\/(?<id>[^/]+)$/,
    "llm-gateway.routing-member.update",
    "routing-member",
  ),
  p(
    ["DELETE"],
    /^\/routing-pools\/[^/]+\/members\/(?<id>[^/]+)$/,
    "llm-gateway.routing-member.delete",
    "routing-member",
  ),
  p(
    ["POST"],
    /^\/routing-pools$/,
    "llm-gateway.routing-pool.create",
    "routing-pool",
  ),
  p(
    ["PATCH"],
    /^\/routing-pools\/(?<id>[^/]+)$/,
    "llm-gateway.routing-pool.update",
    "routing-pool",
  ),
  p(
    ["DELETE"],
    /^\/routing-pools\/(?<id>[^/]+)$/,
    "llm-gateway.routing-pool.delete",
    "routing-pool",
  ),
  p(["POST"], /^\/client-keys$/, "llm-gateway.client-key.create", "client-key"),
  p(
    ["DELETE"],
    /^\/client-keys\/(?<id>[^/]+)$/,
    "llm-gateway.client-key.revoke",
    "client-key",
  ),
  p(["POST"], /^\/control-keys$/, "control-key.create", "control-key"),
  p(
    ["DELETE"],
    /^\/control-keys\/(?<id>[^/]+)$/,
    "control-key.revoke",
    "control-key",
  ),
];

export const matchGatewayAuditPattern = (
  method: string,
  gatewayRelativePath: string,
): GatewayAuditRoutePattern | undefined =>
  GATEWAY_AUDIT_ROUTE_PATTERNS.find(
    (pattern) =>
      pattern.methods.includes(method) &&
      pattern.match.test(gatewayRelativePath),
  );

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_AUDIT_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2_048;

type AuditJson =
  null | boolean | number | string | AuditJson[] | { [key: string]: AuditJson };

const normalizeKey = (key: string): string =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "passphrase",
  "secret",
  "clientsecret",
  "hmacsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "oauthcode",
  "authorizationcode",
  "code",
  "devicecode",
  "usercode",
  "codeverifier",
  "verifier",
  "state",
  "redirecturl",
  "redirecturi",
  "ciphertext",
  "wrappedkey",
  "wrappeddatakey",
  "nonce",
  "authtag",
  "key",
  "keyhash",
  "keyvaultkeyid",
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key);

  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("verifier") ||
    normalized.endsWith("ciphertext") ||
    normalized.endsWith("wrappedkey")
  );
};

/** Redact and bound untrusted request JSON before it reaches the audit store. */
export const redactGatewayAuditValue = (
  value: unknown,
  depth = 0,
): AuditJson => {
  if (depth > MAX_AUDIT_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return value.length <= MAX_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]`;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactGatewayAuditValue(item, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) items.push("[TRUNCATED]");

    return items;
  }
  if (typeof value !== "object") return String(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, child]) => [
        key,
        isSensitiveKey(key)
          ? "[REDACTED]"
          : redactGatewayAuditValue(child, depth + 1),
      ]),
  );
};

const extractCreatedId = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const data = record.data;

  if (
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).id === "string"
  ) {
    return (data as Record<string, unknown>).id as string;
  }

  return typeof record.id === "string" ? record.id : null;
};

/**
 * Audit middleware exclusively for gateway management. It writes through the
 * gateway Prisma client and therefore has no domain-data write path into an
 * integrating application's database. Writes are fail-open, but failures are
 * loud and contain no provider payload.
 */
export const gatewayAuditMiddleware = createMiddleware<{
  Variables: ControlVariables;
}>(async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();

  const method = c.req.method;
  const gatewayRelativePath = c.req.path.replace(/^\/admin\/v1/, "") || "/";
  const pattern = matchGatewayAuditPattern(method, gatewayRelativePath);

  if (!pattern) {
    await next();
    if (c.res.status !== 404) {
      Logger.error("GATEWAY AUDIT GAP: mutation matched no audit pattern", {
        method,
        path: gatewayRelativePath,
      });
    }

    return;
  }

  const entityIdFromPath =
    pattern.match.exec(gatewayRelativePath)?.groups?.id ?? null;
  let requestBody: AuditJson | null = null;

  if (pattern.captureBody && method !== "DELETE") {
    try {
      const rawBody: unknown = await c.req.raw.clone().json();

      requestBody = redactGatewayAuditValue(rawBody);
    } catch {
      requestBody = null;
    }
  }

  await next();

  const status = c.res.status;
  const succeeded = status >= 200 && status < 300;
  let entityId = entityIdFromPath;

  if (succeeded && !entityId) {
    try {
      const responseBody: unknown = await c.res.clone().json();

      entityId = extractCreatedId(responseBody);
    } catch {
      entityId = null;
    }
  }

  const principal = c.get("controlPrincipal");

  try {
    await llmGatewayPrisma.gatewayControlAuditLog.create({
      data: {
        controlCredentialId: principal.credentialId,
        actorId: principal.actor.id,
        actorEmail: principal.actor.email,
        actorName: principal.actor.name,
        action: pattern.action,
        entityType: pattern.entityType,
        entityId,
        method,
        path: gatewayRelativePath,
        after: succeeded && requestBody !== null ? requestBody : undefined,
        status,
        ip: principal.clientAddress,
        userAgent: c.req.header("user-agent") ?? null,
      },
    });
  } catch (error) {
    Logger.error("LLM GATEWAY AUDIT WRITE FAILED", {
      action: pattern.action,
      path: gatewayRelativePath,
      actorId: principal.actor.id,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
});

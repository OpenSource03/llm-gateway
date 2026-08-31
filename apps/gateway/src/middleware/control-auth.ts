import type { ControlActor, ControlVariables } from "./control-principal";

import { createMiddleware } from "hono/factory";

import { getEnv } from "../config/env";
import { GatewayError } from "../core/errors";
import { publicGatewayClientAddress } from "../core/public-client-address";
import { authenticateControlKey } from "../control/control-keys.service";

type Variables = ControlVariables;

const actorHeader = (
  value: string | undefined,
  maximum: number,
): string | undefined => {
  const normalized = value?.trim();

  if (!normalized) return undefined;
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new GatewayError(
      "Invalid delegated actor header",
      400,
      "INVALID_ACTOR",
    );
  }

  return normalized;
};

const delegatedActor = (request: Request): ControlActor | null => {
  const id = actorHeader(
    request.headers.get("x-llm-gateway-actor-id") ?? undefined,
    200,
  );
  const email = actorHeader(
    request.headers.get("x-llm-gateway-actor-email") ?? undefined,
    320,
  );
  const name = actorHeader(
    request.headers.get("x-llm-gateway-actor-name") ?? undefined,
    200,
  );

  if (!id && !email && !name) return null;
  if (!id) {
    throw new GatewayError(
      "Delegated actor id is required",
      400,
      "INVALID_ACTOR",
    );
  }

  return { id, email: email ?? null, name: name ?? null };
};

export const requireControlAuthentication = createMiddleware<{
  Variables: Variables;
}>(async (context, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(
    context.req.header("authorization") ?? "",
  );

  if (!match) {
    throw new GatewayError("Control key required", 401, "CONTROL_KEY_REQUIRED");
  }
  const address = publicGatewayClientAddress(
    context.req.raw,
    getEnv().GATEWAY_TRUSTED_CLIENT_IP_HEADER,
  );
  const credential = await authenticateControlKey(match[1]!.trim(), address);
  const delegated = delegatedActor(context.req.raw);

  if (delegated && !credential.canDelegateActors) {
    throw new GatewayError(
      "This control key cannot delegate actor identity",
      403,
      "ACTOR_DELEGATION_DENIED",
    );
  }
  const actor = delegated ?? {
    id: `control-key:${credential.id}`,
    email: null,
    name: credential.ownerLabel,
  };

  context.set("controlPrincipal", {
    credentialId: credential.id,
    credentialName: credential.name,
    scopes: credential.scopes,
    actor,
    canDelegateActors: credential.canDelegateActors,
    clientAddress: address.startsWith("ip:") ? address.slice(3) : null,
  });
  await next();
});

type ScopeRule = {
  pattern: RegExp;
  read: string;
  write?: string;
};

const SCOPE_RULES: ScopeRule[] = [
  {
    pattern: /^\/oauth-attempts(?:\/|$)/,
    read: "accounts:read",
    write: "accounts:write",
  },
  {
    pattern: /^\/accounts(?:\/|$)/,
    read: "accounts:read",
    write: "accounts:write",
  },
  { pattern: /^\/models(?:\/|$)/, read: "models:read", write: "models:write" },
  {
    pattern: /^\/routing-pools(?:\/|$)/,
    read: "routing:read",
    write: "routing:write",
  },
  {
    pattern: /^\/client-keys(?:\/|$)/,
    read: "client-keys:read",
    write: "client-keys:write",
  },
  {
    pattern: /^\/control-keys(?:\/|$)/,
    read: "control-keys:read",
    write: "control-keys:write",
  },
  { pattern: /^\/requests(?:\/|$)/, read: "requests:read" },
  { pattern: /^\/audit(?:\/|$)/, read: "audit:read" },
];

export const requireControlScope = createMiddleware<{
  Variables: Variables;
}>(async (context, next) => {
  const relativePath = context.req.path.replace(/^\/admin\/v1/, "") || "/";

  if (relativePath === "/status" || relativePath === "/openapi.json") {
    await next();

    return;
  }
  const rule = SCOPE_RULES.find(({ pattern }) => pattern.test(relativePath));

  if (!rule)
    throw new GatewayError(
      "Control route is not scoped",
      403,
      "UNSCOPED_ROUTE",
    );
  const read = context.req.method === "GET" || context.req.method === "HEAD";
  const required = read ? rule.read : rule.write;

  if (!required || !context.get("controlPrincipal").scopes.has(required)) {
    throw new GatewayError("Control scope denied", 403, "CONTROL_SCOPE_DENIED");
  }

  await next();
});

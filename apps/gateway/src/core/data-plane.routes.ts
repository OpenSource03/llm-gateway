import { Hono } from "hono";

import { getEnv } from "../config/env";

import { GatewayError, isGatewayError, retryAfterSeconds } from "./errors";
import { authenticateDataPlaneRequest } from "./data-plane/authentication";
import {
  countGatewayTokens,
  logDataPlaneInternalError,
  proxyCodexSearchRequest,
  proxyMessagesRequest,
  proxyResponsesRequest,
} from "./data-plane.service";
import { codexCatalogEtag } from "./catalog/codex-etag";
import {
  publicClaudeGatewayModels,
  publicCodexGatewayModels,
} from "./catalog/public-models";
import { injectSpawnAgentModelCatalog } from "./catalog/spawn-agent-models";
import { readBoundedRequestBody } from "./read-bounded-body";
import { publicGatewayClientAddress } from "./public-client-address";
import { assertAnthropicMessagesRequest } from "./wire/anthropic";
import { parseCodexResponsesRequest } from "./wire/codex-responses";
import { parseCodexSearchRequest } from "./wire/codex-search";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export const codexRequestSessionHeaders = (
  headers: Headers,
): { provider?: string; routing?: string } => {
  const session = headers.get("session-id") ?? undefined;
  const thread =
    headers.get("thread-id") ?? headers.get("x-client-request-id") ?? undefined;

  return {
    routing: session ?? thread,
    provider: thread ?? session,
  };
};

const readDataPlaneJson = async (request: Request): Promise<unknown> => {
  const contentLength = Number(request.headers.get("content-length") ?? 0);

  if (contentLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(
      "Request body is too large",
      413,
      "REQUEST_TOO_LARGE",
    );
  }
  const bytes = await readBoundedRequestBody(request, MAX_REQUEST_BYTES);

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GatewayError(
      "Request body must be valid JSON",
      400,
      "INVALID_JSON",
    );
  }
};

const readMessagesRequest = async (
  request: Request,
  options: { requireMaxTokens?: boolean } = {},
) => {
  const value = await readDataPlaneJson(request);

  try {
    if (options.requireMaxTokens === false) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Request must be an object");
      }
      const countRequest = value as Record<string, unknown>;

      if (
        typeof countRequest.model !== "string" ||
        !countRequest.model.trim()
      ) {
        throw new TypeError("model is required");
      }
      if (!Array.isArray(countRequest.messages)) {
        throw new TypeError("messages must be an array");
      }
    }
    assertAnthropicMessagesRequest(value, {
      allowMissingMaxTokens: options.requireMaxTokens === false,
    });
    if (options.requireMaxTokens === false) {
      // The internal adapter type expects this generation-only field, while
      // count_tokens does not use it for estimation, billing, or its wire body.
      (value as Record<string, unknown>).max_tokens = 1;
    }
  } catch (error) {
    throw new GatewayError(
      error instanceof Error ? error.message : "Invalid Messages request",
      400,
      "INVALID_REQUEST",
    );
  }

  return value;
};

type PublicErrorProtocol = "anthropic" | "responses";

const publicErrorType = (
  status: number,
  protocol: PublicErrorProtocol,
): string => {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500)
    return protocol === "anthropic" ? "api_error" : "server_error";

  return "invalid_request_error";
};

const gatewayErrorResponse = (
  error: unknown,
  protocol: PublicErrorProtocol,
): Response => {
  const gatewayError = isGatewayError(error)
    ? error
    : new GatewayError("Internal gateway error", 503, "GATEWAY_INTERNAL");
  const retryAfter = retryAfterSeconds(gatewayError.retryAt);
  const headers = new Headers({
    "content-type": "application/json",
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Authorization",
  });

  if (retryAfter !== null) headers.set("Retry-After", String(retryAfter));
  if (!isGatewayError(error)) logDataPlaneInternalError(error);
  const errorType = publicErrorType(gatewayError.status, protocol);
  const body =
    protocol === "anthropic"
      ? {
          type: "error",
          error: { type: errorType, message: gatewayError.message },
          request_id: crypto.randomUUID(),
        }
      : {
          error: {
            message: gatewayError.message,
            type: errorType,
            code: gatewayError.code,
            param: null,
          },
        };

  return new Response(JSON.stringify(body), {
    status: gatewayError.status,
    headers,
  });
};

const anthropicError = (error: unknown): Response =>
  gatewayErrorResponse(error, "anthropic");

const responsesError = (error: unknown): Response =>
  gatewayErrorResponse(error, "responses");

const readCodexResponsesRequest = async (request: Request) => {
  const value = await readDataPlaneJson(request);

  try {
    return parseCodexResponsesRequest(value);
  } catch (error) {
    throw new GatewayError(
      error instanceof Error ? error.message : "Invalid Responses request",
      400,
      "INVALID_REQUEST",
    );
  }
};

const readCodexSearchRequest = async (request: Request) => {
  const value = await readDataPlaneJson(request);

  try {
    return parseCodexSearchRequest(value);
  } catch (error) {
    throw new GatewayError(
      error instanceof Error ? error.message : "Invalid web-search request",
      400,
      "INVALID_REQUEST",
    );
  }
};

const app = new Hono();

const clientAddress = (request: Request): string => {
  return publicGatewayClientAddress(
    request,
    getEnv().GATEWAY_TRUSTED_CLIENT_IP_HEADER,
  );
};

const secureModelListResponse = (response: Response): Response => {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Authorization");

  return response;
};

app.get("/v1/models", async (c) => {
  const isCodexCatalogRequest = c.req.query("client_version") !== undefined;

  try {
    const auth = await authenticateDataPlaneRequest(
      c.req.header("Authorization"),
      clientAddress(c.req.raw),
    );

    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Vary", "Authorization");

    // Codex CLI/Desktop send this stable query parameter and expect their rich
    // `{ models: [...] }` catalog schema. Claude Code receives Anthropic
    // ModelInfo rows from the same provider-discovered source of truth.
    if (isCodexCatalogRequest) {
      const models = await publicCodexGatewayModels(auth.principal);

      c.header("ETag", codexCatalogEtag(models));

      return c.json({ models });
    }

    const models = await publicClaudeGatewayModels(auth.principal);

    return c.json({ object: "list", data: models });
  } catch (error) {
    return secureModelListResponse(
      isCodexCatalogRequest ? responsesError(error) : anthropicError(error),
    );
  }
});

app.post("/v1/responses", async (c) => {
  try {
    // Authenticate before cloning or parsing a potentially large request body.
    const auth = await authenticateDataPlaneRequest(
      c.req.header("Authorization"),
      clientAddress(c.req.raw),
    );
    const request = await readCodexResponsesRequest(c.req.raw.clone());
    const models = await publicCodexGatewayModels(auth.principal);
    const requestWithSpawnCatalog = injectSpawnAgentModelCatalog(
      request,
      models,
    );
    const sessionHeaders = codexRequestSessionHeaders(c.req.raw.headers);

    const response = await proxyResponsesRequest({
      principal: auth.principal,
      request: requestWithSpawnCatalog,
      sessionHeader: sessionHeaders.routing,
      providerSessionHeader: sessionHeaders.provider,
      signal: c.req.raw.signal,
    });

    response.headers.set("X-Models-Etag", codexCatalogEtag(models));

    return response;
  } catch (error) {
    return responsesError(error);
  }
});

app.post("/v1/alpha/search", async (c) => {
  try {
    const auth = await authenticateDataPlaneRequest(
      c.req.header("Authorization"),
      clientAddress(c.req.raw),
    );
    const request = await readCodexSearchRequest(c.req.raw.clone());
    const sessionHeader =
      c.req.header("session-id") ??
      c.req.header("x-client-request-id") ??
      c.req.header("thread-id");

    return await proxyCodexSearchRequest({
      principal: auth.principal,
      request,
      sessionHeader,
      signal: c.req.raw.signal,
    });
  } catch (error) {
    return responsesError(error);
  }
});

app.post("/v1/messages", async (c) => {
  try {
    const auth = await authenticateDataPlaneRequest(
      c.req.header("Authorization"),
      clientAddress(c.req.raw),
    );
    const request = await readMessagesRequest(c.req.raw.clone());

    return await proxyMessagesRequest({
      principal: auth.principal,
      request,
      sessionHeader: c.req.header("X-Claude-Code-Session-Id"),
      signal: c.req.raw.signal,
    });
  } catch (error) {
    return anthropicError(error);
  }
});

app.post("/v1/messages/count_tokens", async (c) => {
  try {
    const auth = await authenticateDataPlaneRequest(
      c.req.header("Authorization"),
      clientAddress(c.req.raw),
    );
    const request = await readMessagesRequest(c.req.raw.clone(), {
      requireMaxTokens: false,
    });

    return await countGatewayTokens({
      principal: auth.principal,
      request,
      sessionHeader: c.req.header("X-Claude-Code-Session-Id"),
      signal: c.req.raw.signal,
    });
  } catch (error) {
    return anthropicError(error);
  }
});

export default app;

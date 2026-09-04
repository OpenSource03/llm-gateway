import { z } from "zod";

export const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const routingPolicySchema = z.enum([
  "QUOTA_BALANCED",
  "WEIGHTED_SHARE",
  "LEAST_UTILIZED",
  "PRIORITY_FAILOVER",
]);

export const controlScopes = [
  "accounts:read",
  "accounts:write",
  "models:read",
  "models:write",
  "routing:read",
  "routing:write",
  "client-keys:read",
  "client-keys:write",
  "requests:read",
  "audit:read",
  "control-keys:read",
  "control-keys:write",
] as const;

export const controlScopeSchema = z.enum(controlScopes);
export type ControlScope = z.infer<typeof controlScopeSchema>;

const optionalIntegerCap = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .nullish();
const optionalBigCap = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .nullish();

export const updateAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    display_name: z.string().trim().min(1).max(120).nullish(),
    max_concurrency: z.number().int().min(1).max(100).nullish(),
    daily_request_cap: optionalIntegerCap,
    daily_input_token_cap: optionalBigCap,
    daily_output_token_cap: optionalBigCap,
    transport_mode: z.enum(["direct", "agent-sdk"]).optional(),
    transport_profile_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .nullish(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field");

export const updateModelSchema = z
  .object({
    enabled: z.boolean().optional(),
    alias: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/)
      .nullish(),
    routing_pool_id: z.string().uuid().nullish(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field");

export const routingPoolFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    policy: routingPolicySchema,
    enabled: z.boolean().optional(),
    sticky_sessions: z.boolean().optional(),
    session_ttl_seconds: z.number().int().min(60).max(2_592_000).optional(),
    short_reset_grace_seconds: z.number().int().min(0).max(86_400).optional(),
    quota_max_age_seconds: z.number().int().min(60).max(86_400).optional(),
    quota_poll_interval_seconds: z
      .number()
      .int()
      .min(60)
      .max(86_400)
      .optional(),
  })
  .strict();

export const createRoutingPoolSchema = routingPoolFieldsSchema.extend({
  provider: providerIdSchema,
});

export const updateRoutingPoolSchema = routingPoolFieldsSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field");

export const quotaRulesSchema = z
  .object({
    maxUtilizationBps: z.number().int().min(0).max(10_000),
    reserveBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine(
    ({ maxUtilizationBps, reserveBps }) => reserveBps <= maxUtilizationBps,
    "reserveBps cannot exceed maxUtilizationBps",
  );

export const routingMemberFieldsSchema = z
  .object({
    account_id: z.string().uuid(),
    enabled: z.boolean().optional(),
    weight: z.number().int().min(1).max(10_000).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    max_concurrency: z.number().int().min(1).max(100).nullish(),
    daily_request_cap: optionalIntegerCap,
    daily_input_token_cap: optionalBigCap,
    daily_output_token_cap: optionalBigCap,
    max_traffic_share_bps: z.number().int().min(1).max(10_000).nullish(),
    quota_rules: quotaRulesSchema.nullish(),
  })
  .strict();

export const updateRoutingMemberSchema = routingMemberFieldsSchema
  .omit({ account_id: true })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field");

export const createClientKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    owner_label: z.string().trim().min(1).max(120),
    owner_email: z.string().email().nullish(),
    allow_all_models: z.boolean().default(false),
    allowed_model_ids: z
      .array(z.string().min(1).max(1_024))
      .max(500)
      .default([]),
    expires_in_days: z.number().int().min(1).max(730).nullish(),
    max_concurrency: z.number().int().min(1).max(100).nullish(),
    daily_request_cap: optionalIntegerCap,
    daily_input_token_cap: optionalBigCap,
    daily_output_token_cap: optionalBigCap,
  })
  .strict();

export const createControlKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    owner_label: z.string().trim().min(1).max(120),
    scopes: z.array(controlScopeSchema).min(1).max(controlScopes.length),
    allowed_cidrs: z
      .array(z.string().trim().min(1).max(64))
      .max(50)
      .default([]),
    can_delegate_actors: z.boolean().default(false),
    expires_in_days: z.number().int().min(1).max(730).nullish(),
  })
  .strict();

export const startOAuthSchema = z
  .object({
    provider: providerIdSchema,
    account_id: z.string().uuid().optional(),
  })
  .strict();

const oauthCompletionValueSchema = z.string().trim().min(1).max(4_096);

export const completeOAuthSchema = z.union([
  z.object({ authorization_code: oauthCompletionValueSchema }).strict(),
  z.object({ redirect_url: oauthCompletionValueSchema }).strict(),
]);

export const linkExternalProfileSchema = z
  .object({
    provider: providerIdSchema,
    transport: z.literal("agent-sdk"),
    profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    account_id: z.string().uuid().optional(),
  })
  .strict();

export type ProviderId = z.infer<typeof providerIdSchema>;
export type GatewayRoutingPolicy = z.infer<typeof routingPolicySchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type UpdateModelInput = z.infer<typeof updateModelSchema>;
export type CreateRoutingPoolInput = z.infer<typeof createRoutingPoolSchema>;
export type UpdateRoutingPoolInput = z.infer<typeof updateRoutingPoolSchema>;
export type CreateRoutingMemberInput = z.infer<
  typeof routingMemberFieldsSchema
>;
export type UpdateRoutingMemberInput = z.infer<
  typeof updateRoutingMemberSchema
>;
export type CreateClientKeyInput = z.infer<typeof createClientKeySchema>;
export type CreateControlKeyInput = z.infer<typeof createControlKeySchema>;
export type StartOAuthInput = z.infer<typeof startOAuthSchema>;
export type CompleteOAuthInput = z.infer<typeof completeOAuthSchema>;
export type LinkExternalProfileInput = z.infer<
  typeof linkExternalProfileSchema
>;

export interface ApiEnvelope<T> {
  success: true;
  data: T;
}

export interface ApiPage<T> extends ApiEnvelope<T[]> {
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

export interface GatewayStatus {
  version: string;
  role: "data" | "control" | "worker" | "all";
  publicBaseUrl: string;
  providers: string[];
  transports: Record<string, string[]>;
  keyWrapper: "local-rsa" | "azure-key-vault";
}

export interface GatewayQuotaWindow {
  key: string;
  label: string;
  utilizationBps: number | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  estimated: boolean;
  observedAt: string;
}

export interface GatewayProviderAccount {
  id: string;
  provider: string;
  email: string | null;
  displayName: string | null;
  workspaceName: string | null;
  planType: string | null;
  transportMode: "direct" | "agent-sdk";
  transportProfileId: string | null;
  enabled: boolean;
  status: "ACTIVE" | "REAUTH_REQUIRED" | "ERROR";
  healthReason: string | null;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  cooldownUntil: string | null;
  lastAuthenticatedAt: string | null;
  lastSuccessfulRequestAt: string | null;
  lastQuotaRefreshAt: string | null;
  availableModelCount: number;
  accessVerificationSupported: boolean;
  quotaWindows: GatewayQuotaWindow[];
  createdAt: string;
}

export interface GatewayAccountAccessVerification {
  status: "ready" | "action_required";
  actionUrl?: string;
}

export interface GatewayExternalTransportProfile {
  id: string;
  email?: string;
  displayName?: string;
  plan?: string;
  authenticated: boolean;
}

export interface GatewayOAuthAttempt {
  id: string;
  provider: string;
  flow: "AUTHORIZATION_CODE" | "DEVICE_CODE";
  status: "PENDING" | "AUTHORIZED" | "FAILED" | "EXPIRED" | "CONSUMED";
  authorizationUrl?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  pollingIntervalSeconds?: number;
  expiresAt: string;
  failureCode?: string | null;
  account?: GatewayProviderAccount;
}

export interface GatewayModel {
  id: string;
  provider: string;
  upstreamModelId: string;
  publicModelId: string;
  displayName: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: unknown;
  enabled: boolean;
  aliases: string[];
  eligibleAccountCount: number;
  routingPoolId: string | null;
  catalogSource: string;
  staleAfter: string | null;
  lastSeenAt: string;
}

export interface GatewayRoutingPoolMember {
  id: string;
  accountId: string;
  accountLabel: string;
  enabled: boolean;
  weight: number;
  priority: number;
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  maxTrafficShareBps: number | null;
  quotaRules: Record<string, unknown> | null;
}

export interface GatewayRoutingPool {
  id: string;
  provider: string;
  name: string;
  policy: GatewayRoutingPolicy;
  enabled: boolean;
  stickySessions: boolean;
  sessionTtlSeconds: number;
  shortResetGraceSeconds: number;
  quotaMaxAgeSeconds: number;
  quotaPollIntervalSeconds: number;
  modelCount: number;
  members: GatewayRoutingPoolMember[];
}

export interface GatewayClientKey {
  id: string;
  name: string;
  ownerLabel: string;
  ownerEmail: string | null;
  keyPrefix: string;
  status: "active" | "disabled" | "expired" | "revoked";
  allowAllModels: boolean;
  allowedModelIds: string[];
  maxConcurrency: number | null;
  dailyRequestCap: number | null;
  dailyInputTokenCap: string | null;
  dailyOutputTokenCap: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedGatewayClientKey extends GatewayClientKey {
  key: string;
}

export interface GatewayControlKey {
  id: string;
  name: string;
  ownerLabel: string;
  keyPrefix: string;
  scopes: ControlScope[];
  allowedCidrs: string[];
  canDelegateActors: boolean;
  status: "active" | "disabled" | "expired" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedGatewayControlKey extends GatewayControlKey {
  key: string;
}

export interface GatewayRequestRow {
  id: string;
  clientKeyId: string;
  clientKeyName?: string | null;
  accountId: string | null;
  accountLabel?: string | null;
  provider: string | null;
  publicModelId: string;
  upstreamModelId: string | null;
  routingPolicy: GatewayRoutingPolicy | null;
  outcome: string;
  errorClass: string | null;
  statusCode: number | null;
  retryCount: number;
  streamed: boolean;
  latencyMs: number | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cachedInputTokens: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface GatewayAuditRow {
  id: string;
  controlCredentialId: string | null;
  actorId: string;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

const jsonBody = (schema: string) => ({
  required: true,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schema}` },
    },
  },
});

const response = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

const pathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});

const queryParameter = (
  name: string,
  schema: Record<string, unknown>,
  required = false,
) => ({
  name,
  in: "query",
  required,
  schema,
});

interface OperationOptions {
  parameters?:
    | Array<ReturnType<typeof pathParameter>>
    | Array<ReturnType<typeof queryParameter>>;
  successStatus?: "200" | "201";
}

const operationIdFromSummary = (summary: string): string => {
  const words = summary.match(/[A-Za-z0-9]+/g) ?? [];

  return words
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : `${word[0]!.toUpperCase()}${word.slice(1)}`,
    )
    .join("");
};

const operation = (
  summary: string,
  scope: ControlScope | null,
  requestSchema?: string,
  options: OperationOptions = {},
) => ({
  summary,
  operationId: operationIdFromSummary(summary),
  security: [{ controlKey: [] }],
  ...(scope ? { "x-required-scope": scope } : {}),
  ...(options.parameters ? { parameters: options.parameters } : {}),
  ...(requestSchema ? { requestBody: jsonBody(requestSchema) } : {}),
  responses: {
    [options.successStatus ?? "200"]: response(
      options.successStatus === "201" ? "Created" : "Success",
    ),
    "400": response("Invalid request"),
    "401": response("Authentication required"),
    "403": response("Scope denied"),
    "413": response("Request body too large"),
    "429": response("Rate or quota limited"),
    "500": response("Internal error"),
  },
});

/** Versioned control-plane contract served by every control-role instance. */
export const controlOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "LLM Gateway Control API",
    version: "0.1.0",
    description:
      "Server-side administration API. Never expose a control key to browser code.",
  },
  servers: [{ url: "/admin/v1" }],
  components: {
    securitySchemes: {
      controlKey: { type: "http", scheme: "bearer", bearerFormat: "llmgw_ctl" },
    },
    schemas: {
      StartOAuth: z.toJSONSchema(startOAuthSchema),
      CompleteOAuth: z.toJSONSchema(completeOAuthSchema),
      LinkExternalProfile: z.toJSONSchema(linkExternalProfileSchema),
      UpdateAccount: z.toJSONSchema(updateAccountSchema),
      UpdateModel: z.toJSONSchema(updateModelSchema),
      CreateRoutingPool: z.toJSONSchema(createRoutingPoolSchema),
      UpdateRoutingPool: z.toJSONSchema(updateRoutingPoolSchema),
      CreateRoutingMember: z.toJSONSchema(routingMemberFieldsSchema),
      UpdateRoutingMember: z.toJSONSchema(updateRoutingMemberSchema),
      CreateClientKey: z.toJSONSchema(createClientKeySchema),
      CreateControlKey: z.toJSONSchema(createControlKeySchema),
    },
  },
  paths: {
    "/openapi.json": {
      get: operation("Get this OpenAPI document", null),
    },
    "/status": { get: operation("Get gateway status", null) },
    "/accounts": { get: operation("List provider accounts", "accounts:read") },
    "/accounts/external-profiles": {
      get: operation(
        "List external transport profiles",
        "accounts:read",
        undefined,
        {
          parameters: [
            queryParameter("provider", { type: "string" }, true),
            queryParameter(
              "transport",
              { type: "string", enum: ["agent-sdk"] },
              true,
            ),
          ],
        },
      ),
      post: operation(
        "Link external transport profile",
        "accounts:write",
        "LinkExternalProfile",
      ),
    },
    "/oauth-attempts": {
      post: operation(
        "Start provider authentication",
        "accounts:write",
        "StartOAuth",
        { successStatus: "201" },
      ),
    },
    "/oauth-attempts/{id}": {
      get: operation(
        "Get provider authentication status",
        "accounts:read",
        undefined,
        { parameters: [pathParameter("id")] },
      ),
    },
    "/oauth-attempts/{id}/poll": {
      post: operation(
        "Poll device authentication",
        "accounts:write",
        undefined,
        { parameters: [pathParameter("id")] },
      ),
    },
    "/oauth-attempts/{id}/complete": {
      post: operation(
        "Complete pasted-code authentication",
        "accounts:write",
        "CompleteOAuth",
        { parameters: [pathParameter("id")] },
      ),
    },
    "/accounts/{id}": {
      patch: operation(
        "Update provider account",
        "accounts:write",
        "UpdateAccount",
        { parameters: [pathParameter("id")] },
      ),
      delete: operation(
        "Delete provider account",
        "accounts:write",
        undefined,
        { parameters: [pathParameter("id")] },
      ),
    },
    "/accounts/{id}/refresh": {
      post: operation("Refresh provider account", "accounts:write", undefined, {
        parameters: [pathParameter("id")],
      }),
    },
    "/accounts/{id}/verify-access": {
      post: operation(
        "Verify provider account access",
        "accounts:write",
        undefined,
        { parameters: [pathParameter("id")] },
      ),
    },
    "/models": { get: operation("List discovered models", "models:read") },
    "/models/refresh": {
      post: operation("Refresh all model catalogs", "models:write"),
    },
    "/models/{id}": {
      patch: operation(
        "Update a published model",
        "models:write",
        "UpdateModel",
        { parameters: [pathParameter("id")] },
      ),
    },
    "/routing-pools": {
      get: operation("List routing pools", "routing:read"),
      post: operation(
        "Create routing pool",
        "routing:write",
        "CreateRoutingPool",
        { successStatus: "201" },
      ),
    },
    "/routing-pools/{id}": {
      patch: operation(
        "Update routing pool",
        "routing:write",
        "UpdateRoutingPool",
        { parameters: [pathParameter("id")] },
      ),
      delete: operation("Delete routing pool", "routing:write", undefined, {
        parameters: [pathParameter("id")],
      }),
    },
    "/routing-pools/{poolId}/members": {
      post: operation(
        "Create routing member",
        "routing:write",
        "CreateRoutingMember",
        {
          parameters: [pathParameter("poolId")],
          successStatus: "201",
        },
      ),
    },
    "/routing-pools/{poolId}/members/{memberId}": {
      patch: operation(
        "Update routing member",
        "routing:write",
        "UpdateRoutingMember",
        {
          parameters: [pathParameter("poolId"), pathParameter("memberId")],
        },
      ),
      delete: operation("Delete routing member", "routing:write", undefined, {
        parameters: [pathParameter("poolId"), pathParameter("memberId")],
      }),
    },
    "/client-keys": {
      get: operation("List data-plane client keys", "client-keys:read"),
      post: operation(
        "Create data-plane client key",
        "client-keys:write",
        "CreateClientKey",
        { successStatus: "201" },
      ),
    },
    "/client-keys/{id}": {
      delete: operation(
        "Revoke data-plane client key",
        "client-keys:write",
        undefined,
        { parameters: [pathParameter("id")] },
      ),
    },
    "/control-keys": {
      get: operation("List control keys", "control-keys:read"),
      post: operation(
        "Create control key",
        "control-keys:write",
        "CreateControlKey",
        { successStatus: "201" },
      ),
    },
    "/control-keys/{id}": {
      delete: operation("Revoke control key", "control-keys:write", undefined, {
        parameters: [pathParameter("id")],
      }),
    },
    "/requests": {
      get: operation("List inference history", "requests:read", undefined, {
        parameters: [
          queryParameter("page", { type: "integer", minimum: 1, default: 1 }),
          queryParameter("per_page", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          }),
          queryParameter("provider", { type: "string" }),
          queryParameter("model", { type: "string" }),
          queryParameter("outcome", { type: "string" }),
          queryParameter("client_key_id", {
            type: "string",
            format: "uuid",
          }),
        ],
      }),
    },
    "/audit": {
      get: operation("List control audit history", "audit:read", undefined, {
        parameters: [
          queryParameter("page", { type: "integer", minimum: 1, default: 1 }),
          queryParameter("per_page", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          }),
          queryParameter("actor_id", { type: "string" }),
          queryParameter("action", { type: "string" }),
          queryParameter("entity_type", { type: "string" }),
          queryParameter("status", {
            type: "integer",
            minimum: 100,
            maximum: 599,
          }),
        ],
      }),
    },
  },
} as const;

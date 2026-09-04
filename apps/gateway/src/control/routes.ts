import type { ControlVariables } from "../middleware/control-principal";

import { Hono } from "hono";
import { z } from "zod";
import {
  completeOAuthSchema,
  createClientKeySchema,
  controlOpenApiDocument,
  createControlKeySchema,
  createRoutingPoolSchema,
  linkExternalProfileSchema,
  providerIdSchema,
  routingMemberFieldsSchema,
  startOAuthSchema,
  updateAccountSchema,
  updateModelSchema,
  updateRoutingMemberSchema,
  updateRoutingPoolSchema,
} from "@opensource03/llm-gateway-contracts";

import { getEnv } from "../config/env";
import { listProviderAdapters } from "../core/providers";
import { toDbProvider } from "../core/providers/provider-id";
import { zValidator } from "../shared/hono-validator";

import {
  completeOAuthAttempt,
  deleteGatewayAccount,
  getOAuthAttempt,
  listGatewayAccounts,
  linkGatewayExternalProfile,
  listGatewayExternalProfiles,
  pollOAuthAttempt,
  refreshGatewayAccount,
  startOAuthAttempt,
  updateGatewayAccount,
  verifyGatewayAccountAccess,
} from "./accounts.service";
import {
  createGatewayClientKey,
  listGatewayClientKeys,
  revokeGatewayClientKey,
} from "./client-keys.service";
import {
  listGatewayModels,
  refreshGatewayModels,
  updateGatewayModel,
} from "./models.service";
import {
  createRoutingMember,
  createRoutingPool,
  deleteRoutingMember,
  deleteRoutingPool,
  listRoutingPools,
  updateRoutingMember,
  updateRoutingPool,
} from "./routing.service";
import { listGatewayRequestHistory } from "./history.service";
import { listGatewayAudit } from "./audit.service";
import {
  createControlKey,
  listControlKeys,
  revokeControlKey,
} from "./control-keys.service";

const provider = providerIdSchema.refine(
  (id) => listProviderAdapters().some((adapter) => adapter.id === id),
  "Provider adapter is not installed",
);
const idParams = z.object({ id: z.string().uuid() });
const attemptParams = z.object({ id: z.string().uuid() });
const poolParams = z.object({ poolId: z.string().uuid() });
const memberParams = z.object({
  poolId: z.string().uuid(),
  memberId: z.string().uuid(),
});

const oauthCompletionSchema = completeOAuthSchema.transform((body) =>
  "authorization_code" in body ? body.authorization_code : body.redirect_url,
);
const oauthStartSchema = startOAuthSchema.extend({ provider });
const externalProfileQuerySchema = z.object({
  provider,
  transport: z.literal("agent-sdk"),
});
const externalProfileLinkSchema = linkExternalProfileSchema.extend({
  provider,
});

const createPoolSchema = createRoutingPoolSchema.extend({ provider });
const toBigIntCap = (
  value: string | number | null | undefined,
): bigint | null | undefined =>
  value === null || value === undefined ? value : BigInt(value);

const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  provider: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
    .optional(),
  model: z.string().max(200).optional(),
  outcome: z.string().max(80).optional(),
  client_key_id: z.string().uuid().optional(),
});
const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  actor_id: z.string().max(200).optional(),
  action: z.string().max(120).optional(),
  entity_type: z.string().max(120).optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
});

const app = new Hono<{ Variables: ControlVariables }>();

app.get("/openapi.json", (c) => c.json(controlOpenApiDocument));

app.get("/status", (c) => {
  const env = getEnv();
  const adapters = listProviderAdapters();

  return c.json({
    success: true,
    data: {
      version: "0.1.0",
      role: env.GATEWAY_ROLE,
      publicBaseUrl: env.GATEWAY_PUBLIC_URL.replace(/\/$/, ""),
      providers: adapters.map(({ id }) => id),
      transports: Object.fromEntries(
        adapters.map((adapter) => [
          adapter.id,
          [
            "direct",
            ...(adapter.id === "anthropic" &&
            adapter.prepareExternalInference &&
            env.GATEWAY_ANTHROPIC_AGENT_SDK_URL
              ? ["agent-sdk"]
              : []),
          ],
        ]),
      ),
      keyWrapper: env.GATEWAY_KEY_WRAPPER,
    },
  });
});

app.get("/accounts", async (c) =>
  c.json({ success: true, data: await listGatewayAccounts() }),
);
app.get(
  "/accounts/external-profiles",
  zValidator("query", externalProfileQuerySchema),
  async (c) => {
    const query = c.req.valid("query");

    return c.json({
      success: true,
      data: await listGatewayExternalProfiles(
        query.provider,
        query.transport,
        c.req.raw.signal,
      ),
    });
  },
);
app.post(
  "/accounts/external-profiles",
  zValidator("json", externalProfileLinkSchema),
  async (c) => {
    const body = c.req.valid("json");

    return c.json({
      success: true,
      data: await linkGatewayExternalProfile(
        c.get("controlPrincipal").actor,
        {
          provider: body.provider,
          transportId: body.transport,
          profileId: body.profile_id,
          accountId: body.account_id,
        },
        c.req.raw.signal,
      ),
    });
  },
);
app.post("/oauth-attempts", zValidator("json", oauthStartSchema), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const body = c.req.valid("json");
  const created = await startOAuthAttempt(
    c.get("controlPrincipal").actor,
    body.provider,
    body.account_id,
  );

  return c.json({ success: true, data: created }, 201);
});
app.get(
  "/oauth-attempts/:id",
  zValidator("param", attemptParams),
  async (c) => {
    c.header("Cache-Control", "private, no-store");

    return c.json({
      success: true,
      data: await getOAuthAttempt(c.req.valid("param").id),
    });
  },
);
app.post(
  "/oauth-attempts/:id/poll",
  zValidator("param", attemptParams),
  async (c) => {
    c.header("Cache-Control", "private, no-store");

    return c.json({
      success: true,
      data: await pollOAuthAttempt(c.req.valid("param").id),
    });
  },
);
app.post(
  "/oauth-attempts/:id/complete",
  zValidator("param", attemptParams),
  zValidator("json", oauthCompletionSchema),
  async (c) => {
    c.header("Cache-Control", "private, no-store");

    return c.json({
      success: true,
      data: await completeOAuthAttempt(
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    });
  },
);

app.patch(
  "/accounts/:id",
  zValidator("param", idParams),
  zValidator("json", updateAccountSchema),
  async (c) => {
    const body = c.req.valid("json");

    return c.json({
      success: true,
      data: await updateGatewayAccount(c.req.valid("param").id, {
        enabled: body.enabled,
        displayName: body.display_name,
        maxConcurrency: body.max_concurrency,
        dailyRequestCap: body.daily_request_cap,
        dailyInputTokenCap: toBigIntCap(body.daily_input_token_cap),
        dailyOutputTokenCap: toBigIntCap(body.daily_output_token_cap),
        transportMode: body.transport_mode,
        transportProfileId: body.transport_profile_id,
      }),
    });
  },
);
app.post("/accounts/:id/refresh", zValidator("param", idParams), async (c) =>
  c.json({
    success: true,
    data: await refreshGatewayAccount(c.req.valid("param").id, {
      refreshCredential: true,
    }),
  }),
);
app.post(
  "/accounts/:id/verify-access",
  zValidator("param", idParams),
  async (c) => {
    c.header("Cache-Control", "private, no-store");

    return c.json({
      success: true,
      data: await verifyGatewayAccountAccess(
        c.req.valid("param").id,
        c.req.raw.signal,
      ),
    });
  },
);
app.delete("/accounts/:id", zValidator("param", idParams), async (c) =>
  c.json({
    success: true,
    data: await deleteGatewayAccount(c.req.valid("param").id),
  }),
);

app.get("/models", async (c) =>
  c.json({ success: true, data: await listGatewayModels() }),
);
app.post("/models/refresh", async (c) =>
  c.json({ success: true, data: await refreshGatewayModels() }),
);
app.patch(
  "/models/:id",
  zValidator("param", idParams),
  zValidator("json", updateModelSchema),
  async (c) => {
    const body = c.req.valid("json");

    return c.json({
      success: true,
      data: await updateGatewayModel(c.req.valid("param").id, {
        enabled: body.enabled,
        alias: body.alias,
        routingPoolId: body.routing_pool_id,
      }),
    });
  },
);

app.get("/routing-pools", async (c) =>
  c.json({ success: true, data: await listRoutingPools() }),
);
app.post("/routing-pools", zValidator("json", createPoolSchema), async (c) => {
  const body = c.req.valid("json");

  return c.json(
    {
      success: true,
      data: await createRoutingPool({
        provider: toDbProvider(body.provider),
        name: body.name,
        policy: body.policy,
        enabled: body.enabled,
        stickySessions: body.sticky_sessions,
        sessionTtlSeconds: body.session_ttl_seconds,
        shortResetGraceSeconds: body.short_reset_grace_seconds,
        quotaMaxAgeSeconds: body.quota_max_age_seconds,
        quotaPollIntervalSeconds: body.quota_poll_interval_seconds,
      }),
    },
    201,
  );
});
app.patch(
  "/routing-pools/:id",
  zValidator("param", idParams),
  zValidator("json", updateRoutingPoolSchema),
  async (c) => {
    const body = c.req.valid("json");

    return c.json({
      success: true,
      data: await updateRoutingPool(c.req.valid("param").id, {
        name: body.name,
        policy: body.policy,
        enabled: body.enabled,
        stickySessions: body.sticky_sessions,
        sessionTtlSeconds: body.session_ttl_seconds,
        shortResetGraceSeconds: body.short_reset_grace_seconds,
        quotaMaxAgeSeconds: body.quota_max_age_seconds,
        quotaPollIntervalSeconds: body.quota_poll_interval_seconds,
      }),
    });
  },
);
app.delete("/routing-pools/:id", zValidator("param", idParams), async (c) =>
  c.json({
    success: true,
    data: await deleteRoutingPool(c.req.valid("param").id),
  }),
);
app.post(
  "/routing-pools/:poolId/members",
  zValidator("param", poolParams),
  zValidator("json", routingMemberFieldsSchema),
  async (c) => {
    const body = c.req.valid("json");

    return c.json(
      {
        success: true,
        data: await createRoutingMember(c.req.valid("param").poolId, {
          accountId: body.account_id,
          enabled: body.enabled,
          weight: body.weight,
          priority: body.priority,
          maxConcurrency: body.max_concurrency,
          dailyRequestCap: body.daily_request_cap,
          dailyInputTokenCap: toBigIntCap(body.daily_input_token_cap),
          dailyOutputTokenCap: toBigIntCap(body.daily_output_token_cap),
          maxTrafficShareBps: body.max_traffic_share_bps,
          quotaRules: body.quota_rules,
        }),
      },
      201,
    );
  },
);
app.patch(
  "/routing-pools/:poolId/members/:memberId",
  zValidator("param", memberParams),
  zValidator("json", updateRoutingMemberSchema),
  async (c) => {
    const params = c.req.valid("param");
    const body = c.req.valid("json");

    return c.json({
      success: true,
      data: await updateRoutingMember(params.poolId, params.memberId, {
        enabled: body.enabled,
        weight: body.weight,
        priority: body.priority,
        maxConcurrency: body.max_concurrency,
        dailyRequestCap: body.daily_request_cap,
        dailyInputTokenCap: toBigIntCap(body.daily_input_token_cap),
        dailyOutputTokenCap: toBigIntCap(body.daily_output_token_cap),
        maxTrafficShareBps: body.max_traffic_share_bps,
        quotaRules: body.quota_rules,
      }),
    });
  },
);
app.delete(
  "/routing-pools/:poolId/members/:memberId",
  zValidator("param", memberParams),
  async (c) => {
    const params = c.req.valid("param");

    return c.json({
      success: true,
      data: await deleteRoutingMember(params.poolId, params.memberId),
    });
  },
);

app.get("/client-keys", async (c) =>
  c.json({ success: true, data: await listGatewayClientKeys() }),
);
app.post(
  "/client-keys",
  zValidator("json", createClientKeySchema),
  async (c) => {
    // The response contains the only copy of the bearer secret. Prevent every
    // browser and intermediary cache from retaining it.
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    const body = c.req.valid("json");

    return c.json(
      {
        success: true,
        data: await createGatewayClientKey(c.get("controlPrincipal").actor, {
          name: body.name,
          ownerLabel: body.owner_label,
          ownerEmail: body.owner_email,
          allowAllModels: body.allow_all_models,
          allowedModelIds: body.allowed_model_ids,
          expiresInDays: body.expires_in_days,
          maxConcurrency: body.max_concurrency,
          dailyRequestCap: body.daily_request_cap,
          dailyInputTokenCap: toBigIntCap(body.daily_input_token_cap),
          dailyOutputTokenCap: toBigIntCap(body.daily_output_token_cap),
        }),
      },
      201,
    );
  },
);
app.delete("/client-keys/:id", zValidator("param", idParams), async (c) =>
  c.json({
    success: true,
    data: await revokeGatewayClientKey(c.req.valid("param").id),
  }),
);

app.get("/requests", zValidator("query", historyQuery), async (c) => {
  const query = c.req.valid("query");
  const result = await listGatewayRequestHistory({
    page: query.page,
    perPage: query.per_page,
    provider: query.provider?.toUpperCase(),
    model: query.model,
    outcome: query.outcome,
    clientKeyId: query.client_key_id,
  });

  return c.json({
    success: true,
    data: result.rows,
    pagination: {
      total: result.total,
      page: query.page,
      per_page: query.per_page,
      total_pages: Math.ceil(result.total / query.per_page),
    },
  });
});

app.get("/control-keys", async (c) =>
  c.json({ success: true, data: await listControlKeys() }),
);
app.post(
  "/control-keys",
  zValidator("json", createControlKeySchema),
  async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    const principal = c.get("controlPrincipal");

    return c.json(
      {
        success: true,
        data: await createControlKey(principal.actor.id, c.req.valid("json")),
      },
      201,
    );
  },
);
app.delete("/control-keys/:id", zValidator("param", idParams), async (c) =>
  c.json({
    success: true,
    data: await revokeControlKey(c.req.valid("param").id),
  }),
);

app.get("/audit", zValidator("query", auditQuery), async (c) => {
  const query = c.req.valid("query");
  const result = await listGatewayAudit({
    page: query.page,
    perPage: query.per_page,
    actorId: query.actor_id,
    action: query.action,
    entityType: query.entity_type,
    status: query.status,
  });

  return c.json({
    success: true,
    data: result.rows,
    pagination: {
      total: result.total,
      page: query.page,
      per_page: query.per_page,
      total_pages: Math.ceil(result.total / query.per_page),
    },
  });
});

export default app;

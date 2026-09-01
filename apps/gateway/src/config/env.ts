import { z } from "zod";

const roleSchema = z.enum(["data", "control", "worker", "all"]);
const keyWrapperSchema = z.enum(["local-rsa", "azure-key-vault"]);
const providerModelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
const agentSdkModelRewriteSchema = z
  .array(
    z
      .object({
        from: providerModelIdSchema,
        to: providerModelIdSchema,
        displayName: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  )
  .max(32)
  .superRefine((rewrites, context) => {
    const sources = new Set<string>();

    for (const [index, rewrite] of rewrites.entries()) {
      if (sources.has(rewrite.from)) {
        context.addIssue({
          code: "custom",
          path: [index, "from"],
          message: "Model rewrite sources must be unique",
        });
      }
      sources.add(rewrite.from);
    }
  });
const agentSdkModelRewritesJsonSchema = z
  .string()
  .max(16_384)
  .default("[]")
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Must be valid JSON",
      });

      return z.NEVER;
    }
  })
  .pipe(agentSdkModelRewriteSchema);

const rawEnvironment = () => ({
  NODE_ENV: process.env.NODE_ENV,
  GATEWAY_ROLE: process.env.GATEWAY_ROLE,
  GATEWAY_DATABASE_URL:
    process.env.GATEWAY_DATABASE_URL ?? process.env.LLM_GATEWAY_DATABASE_URL,
  GATEWAY_DATABASE_SSL_MODE: process.env.GATEWAY_DATABASE_SSL_MODE,
  GATEWAY_PUBLIC_URL: process.env.GATEWAY_PUBLIC_URL,
  GATEWAY_DATA_HOST: process.env.GATEWAY_DATA_HOST,
  GATEWAY_DATA_PORT: process.env.GATEWAY_DATA_PORT,
  GATEWAY_CONTROL_HOST: process.env.GATEWAY_CONTROL_HOST,
  GATEWAY_CONTROL_PORT: process.env.GATEWAY_CONTROL_PORT,
  GATEWAY_SESSION_HMAC_SECRET:
    process.env.GATEWAY_SESSION_HMAC_SECRET ??
    process.env.LLM_GATEWAY_HMAC_SECRET,
  GATEWAY_KEY_WRAPPER: process.env.GATEWAY_KEY_WRAPPER,
  GATEWAY_LOCAL_RSA_KEY_PATH:
    process.env.GATEWAY_LOCAL_RSA_KEY_PATH ??
    process.env.LLM_GATEWAY_LOCAL_RSA_KEY_PATH,
  GATEWAY_AZURE_KEY_VAULT_KEY_ID:
    process.env.GATEWAY_AZURE_KEY_VAULT_KEY_ID ??
    process.env.LLM_GATEWAY_KEY_VAULT_KEY_ID,
  AZURE_MANAGED_IDENTITY_CLIENT_ID:
    process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID,
  GATEWAY_TRUSTED_CLIENT_IP_HEADER:
    process.env.GATEWAY_TRUSTED_CLIENT_IP_HEADER ??
    process.env.LLM_GATEWAY_TRUSTED_CLIENT_IP_HEADER,
  GATEWAY_HISTORY_RETENTION_DAYS: process.env.GATEWAY_HISTORY_RETENTION_DAYS,
  GATEWAY_OAUTH_RETENTION_HOURS: process.env.GATEWAY_OAUTH_RETENTION_HOURS,
  GATEWAY_LEGACY_BASE_PATH: process.env.GATEWAY_LEGACY_BASE_PATH,
  GATEWAY_ANTHROPIC_AGENT_SDK_URL: process.env.GATEWAY_ANTHROPIC_AGENT_SDK_URL,
  GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY:
    process.env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY,
  GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE:
    process.env.GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE,
  GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON:
    process.env.GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON,
  LOG_LEVEL: process.env.LOG_LEVEL,
});

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    GATEWAY_ROLE: roleSchema.default("all"),
    GATEWAY_DATABASE_URL: z.string().url(),
    GATEWAY_DATABASE_SSL_MODE: z
      .enum(["disable", "require", "verify-full"])
      .optional(),
    GATEWAY_PUBLIC_URL: z.string().url().default("http://localhost:8080"),
    GATEWAY_DATA_HOST: z.string().min(1).default("0.0.0.0"),
    GATEWAY_DATA_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    GATEWAY_CONTROL_HOST: z.string().min(1).default("127.0.0.1"),
    GATEWAY_CONTROL_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(8081),
    GATEWAY_SESSION_HMAC_SECRET: z.string().min(32),
    GATEWAY_KEY_WRAPPER: keyWrapperSchema.optional(),
    GATEWAY_LOCAL_RSA_KEY_PATH: z.string().min(1).optional(),
    GATEWAY_AZURE_KEY_VAULT_KEY_ID: z.string().url().optional(),
    AZURE_MANAGED_IDENTITY_CLIENT_ID: z.string().min(1).optional(),
    GATEWAY_TRUSTED_CLIENT_IP_HEADER: z
      .enum(["x-azure-clientip", "x-real-ip"])
      .optional(),
    GATEWAY_HISTORY_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_650)
      .default(90),
    GATEWAY_OAUTH_RETENTION_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24),
    GATEWAY_LEGACY_BASE_PATH: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]*$/)
      .default("/api/llm-gateway"),
    GATEWAY_ANTHROPIC_AGENT_SDK_URL: z.string().url().optional(),
    GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: z.string().min(32).optional(),
    GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE: z
      .enum(["true", "false", "1", "0"])
      .default("false")
      .transform((value) => value === "true" || value === "1"),
    GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON:
      agentSdkModelRewritesJsonSchema,
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .superRefine((env, context) => {
    const wrapper =
      env.GATEWAY_KEY_WRAPPER ??
      (env.GATEWAY_LOCAL_RSA_KEY_PATH
        ? "local-rsa"
        : env.GATEWAY_AZURE_KEY_VAULT_KEY_ID
          ? "azure-key-vault"
          : undefined);

    if (!wrapper) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_KEY_WRAPPER"],
        message: "Configure a local-rsa or azure-key-vault key wrapper",
      });
    }
    if (wrapper === "local-rsa" && !env.GATEWAY_LOCAL_RSA_KEY_PATH) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_LOCAL_RSA_KEY_PATH"],
        message: "Required for the local-rsa key wrapper",
      });
    }
    if (wrapper === "azure-key-vault" && !env.GATEWAY_AZURE_KEY_VAULT_KEY_ID) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_AZURE_KEY_VAULT_KEY_ID"],
        message: "Required for the azure-key-vault key wrapper",
      });
    }
    if (env.GATEWAY_DATA_PORT === env.GATEWAY_CONTROL_PORT) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_CONTROL_PORT"],
        message: "Data and control ports must be different",
      });
    }
    const databaseUrl = new URL(env.GATEWAY_DATABASE_URL);

    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_DATABASE_URL"],
        message: "Must be a PostgreSQL URL",
      });
    }
    const publicUrl = new URL(env.GATEWAY_PUBLIC_URL);

    if (
      !["http:", "https:"].includes(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.search ||
      publicUrl.hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_PUBLIC_URL"],
        message: "Must be a credential-free HTTP(S) base URL",
      });
    }
    if (wrapper === "azure-key-vault" && env.GATEWAY_AZURE_KEY_VAULT_KEY_ID) {
      const keyUrl = new URL(env.GATEWAY_AZURE_KEY_VAULT_KEY_ID);
      const segments = keyUrl.pathname.split("/").filter(Boolean);

      if (
        keyUrl.protocol !== "https:" ||
        keyUrl.username ||
        keyUrl.password ||
        keyUrl.port ||
        keyUrl.search ||
        keyUrl.hash ||
        !/^[a-z0-9-]+\.vault\.azure\.net$/i.test(keyUrl.hostname) ||
        segments.length !== 3 ||
        segments[0] !== "keys"
      ) {
        context.addIssue({
          code: "custom",
          path: ["GATEWAY_AZURE_KEY_VAULT_KEY_ID"],
          message: "Must be an immutable Azure Key Vault RSA key version URL",
        });
      }
    }
    if (
      Boolean(env.GATEWAY_ANTHROPIC_AGENT_SDK_URL) !==
      Boolean(env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_ANTHROPIC_AGENT_SDK_URL"],
        message: "Agent SDK URL and API key must be configured together",
      });
    }
    if (env.GATEWAY_ANTHROPIC_AGENT_SDK_URL) {
      const url = new URL(env.GATEWAY_ANTHROPIC_AGENT_SDK_URL);
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(
        url.hostname.toLowerCase(),
      );

      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["", "/"].includes(url.pathname)
      ) {
        context.addIssue({
          code: "custom",
          path: ["GATEWAY_ANTHROPIC_AGENT_SDK_URL"],
          message: "Must be a credential-free HTTP(S) origin",
        });
      }
      if (
        url.protocol === "http:" &&
        !loopback &&
        !env.GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE
      ) {
        context.addIssue({
          code: "custom",
          path: ["GATEWAY_ANTHROPIC_AGENT_SDK_URL"],
          message:
            "Plain HTTP is limited to loopback unless explicitly allowed on a private network",
        });
      }
    }
  })
  .transform((env) => ({
    ...env,
    GATEWAY_DATABASE_SSL_MODE:
      env.GATEWAY_DATABASE_SSL_MODE ??
      (env.NODE_ENV === "production" ? "verify-full" : "disable"),
    GATEWAY_KEY_WRAPPER:
      env.GATEWAY_KEY_WRAPPER ??
      (env.GATEWAY_LOCAL_RSA_KEY_PATH
        ? ("local-rsa" as const)
        : ("azure-key-vault" as const)),
  }));

export type GatewayEnvironment = z.infer<typeof envSchema>;

let cachedEnvironment: GatewayEnvironment | undefined;

export const getEnv = (): GatewayEnvironment => {
  cachedEnvironment ??= envSchema.parse(rawEnvironment());

  return cachedEnvironment;
};

export const resetEnvForTests = (): void => {
  cachedEnvironment = undefined;
};

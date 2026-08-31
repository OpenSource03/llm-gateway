import assert from "node:assert/strict";
import test from "node:test";

import {
  DATABASE_PLACEHOLDER_URL,
  resolveDatasourceUrl,
} from "../../prisma.config";
import { envSchema } from "../config/env";

const runtimeEnv = (overrides: Record<string, string | undefined> = {}) => ({
  GATEWAY_DATABASE_URL:
    "postgresql://gateway:gateway-secret@gateway-db.internal:5432/gateway",
  GATEWAY_PUBLIC_URL: "https://gateway.example.com",
  GATEWAY_SESSION_HMAC_SECRET: "h".repeat(32),
  GATEWAY_KEY_WRAPPER: "azure-key-vault",
  GATEWAY_AZURE_KEY_VAULT_KEY_ID:
    "https://gateway-vault.vault.azure.net/keys/credentials/version-1",
  NODE_ENV: "production",
  ...overrides,
});

test("runtime requires a configured key-wrapper contract", () => {
  assert.equal(envSchema.safeParse(runtimeEnv()).success, true);
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_KEY_WRAPPER: "local-rsa",
        GATEWAY_AZURE_KEY_VAULT_KEY_ID: undefined,
        GATEWAY_LOCAL_RSA_KEY_PATH: "/run/secrets/gateway.pem",
      }),
    ).success,
    true,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_KEY_WRAPPER: undefined,
        GATEWAY_AZURE_KEY_VAULT_KEY_ID: undefined,
      }),
    ).success,
    false,
  );
});

test("runtime keeps data and control listeners distinct", () => {
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({ GATEWAY_DATA_PORT: "8080", GATEWAY_CONTROL_PORT: "8080" }),
    ).success,
    false,
  );
});

test("database TLS defaults fail closed in production and remain configurable locally", () => {
  assert.equal(
    envSchema.parse(runtimeEnv()).GATEWAY_DATABASE_SSL_MODE,
    "verify-full",
  );
  assert.equal(
    envSchema.parse(runtimeEnv({ GATEWAY_DATABASE_SSL_MODE: "disable" }))
      .GATEWAY_DATABASE_SSL_MODE,
    "disable",
  );
});

test("runtime rejects unsafe public, database, and mutable Key Vault URLs", () => {
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({ GATEWAY_DATABASE_URL: "https://database.example.test" }),
    ).success,
    false,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({ GATEWAY_PUBLIC_URL: "https://user:secret@gateway.example" }),
    ).success,
    false,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_AZURE_KEY_VAULT_KEY_ID:
          "https://gateway-vault.vault.azure.net/keys/credentials",
      }),
    ).success,
    false,
  );
});

test("Agent SDK transport requires paired credentials and explicit insecure networking", () => {
  const key = "a".repeat(32);

  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "https://agent-sdk.internal",
        GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: key,
      }),
    ).success,
    true,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "http://127.0.0.1:3456",
        GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: key,
      }),
    ).success,
    true,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "http://agent-sdk:3456",
        GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: key,
      }),
    ).success,
    false,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "http://agent-sdk:3456",
        GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: key,
        GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE: "true",
      }),
    ).success,
    true,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "https://agent-sdk.internal/path",
        GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY: key,
      }),
    ).success,
    false,
  );
  assert.equal(
    envSchema.safeParse(
      runtimeEnv({
        GATEWAY_ANTHROPIC_AGENT_SDK_URL: "https://agent-sdk.internal",
      }),
    ).success,
    false,
  );
});

test("Prisma generation is secret-independent", () => {
  assert.equal(
    resolveDatasourceUrl({}, ["node", "prisma", "generate"]),
    DATABASE_PLACEHOLDER_URL,
  );
});

test("migrations require a real, explicitly pinned PostgreSQL target", () => {
  const argv = ["node", "prisma", "migrate", "deploy"];
  const url =
    "postgresql://owner:migration-secret@gateway-db.internal:5432/gateway";

  assert.throws(() => resolveDatasourceUrl({}, argv), /GATEWAY_DATABASE_URL/);
  assert.throws(
    () => resolveDatasourceUrl({ GATEWAY_DATABASE_URL: url }, argv),
    /GATEWAY_MIGRATION_EXPECTED_HOST/,
  );
  assert.throws(
    () =>
      resolveDatasourceUrl(
        {
          GATEWAY_DATABASE_URL: url,
          GATEWAY_MIGRATION_EXPECTED_HOST: "other.internal",
          GATEWAY_MIGRATION_EXPECTED_DATABASE: "gateway",
        },
        argv,
      ),
    /pinned migration target/,
  );
  assert.equal(
    resolveDatasourceUrl(
      {
        GATEWAY_DATABASE_URL: url,
        GATEWAY_MIGRATION_EXPECTED_HOST: "gateway-db.internal",
        GATEWAY_MIGRATION_EXPECTED_DATABASE: "gateway",
      },
      argv,
    ),
    url,
  );
});

test("Prisma direct db commands and production Studio are disabled", () => {
  const environment = {
    GATEWAY_DATABASE_URL:
      "postgresql://owner:migration-secret@gateway-db.internal:5432/gateway",
  };

  assert.throws(
    () => resolveDatasourceUrl(environment, ["node", "prisma", "db", "push"]),
    /Direct Prisma db commands are disabled/,
  );
  assert.throws(
    () =>
      resolveDatasourceUrl({ ...environment, NODE_ENV: "production" }, [
        "node",
        "prisma",
        "studio",
      ]),
    /Studio is disabled/,
  );
});

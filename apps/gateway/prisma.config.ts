import "dotenv/config";

import { defineConfig } from "prisma/config";

export const DATABASE_PLACEHOLDER_URL =
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

interface MigrationEnvironment {
  GATEWAY_DATABASE_URL?: string;
  GATEWAY_MIGRATION_EXPECTED_DATABASE?: string;
  GATEWAY_MIGRATION_EXPECTED_HOST?: string;
  NODE_ENV?: string;
}

const isDatabaseCommand = (argv: readonly string[]): boolean =>
  argv.includes("migrate") || argv.includes("studio");

const assertPinnedMigrationTarget = (
  connectionString: string,
  environment: MigrationEnvironment,
): void => {
  const target = new URL(connectionString);
  const expectedHost =
    environment.GATEWAY_MIGRATION_EXPECTED_HOST?.trim().toLowerCase();
  const expectedDatabase =
    environment.GATEWAY_MIGRATION_EXPECTED_DATABASE?.trim();
  const database = decodeURIComponent(target.pathname.slice(1));

  if (!expectedHost || !expectedDatabase) {
    throw new Error(
      "GATEWAY_MIGRATION_EXPECTED_HOST and GATEWAY_MIGRATION_EXPECTED_DATABASE are required",
    );
  }
  if (
    target.hostname.toLowerCase() !== expectedHost ||
    database !== expectedDatabase
  ) {
    throw new Error(
      "Gateway database does not match the pinned migration target",
    );
  }
};

export const resolveDatasourceUrl = (
  environment: MigrationEnvironment,
  argv: readonly string[],
): string => {
  if (argv.includes("db")) {
    throw new Error("Direct Prisma db commands are disabled; use migrations");
  }
  const configured = environment.GATEWAY_DATABASE_URL?.trim();

  if (!isDatabaseCommand(argv)) return configured || DATABASE_PLACEHOLDER_URL;
  if (argv.includes("studio") && environment.NODE_ENV === "production") {
    throw new Error("Prisma Studio is disabled in production");
  }
  if (!configured || configured === DATABASE_PLACEHOLDER_URL) {
    throw new Error("GATEWAY_DATABASE_URL is required for database commands");
  }
  const parsed = new URL(configured);

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("GATEWAY_DATABASE_URL must be a PostgreSQL URL");
  }
  if (argv.includes("migrate")) {
    assertPinnedMigrationTarget(configured, environment);
  }

  return configured;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: resolveDatasourceUrl(process.env, process.argv) },
});

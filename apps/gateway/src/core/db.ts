import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import type { PrismaClient as GatewayPrismaClient } from "../generated/prisma/client";

import { PrismaClient } from "../generated/prisma/client";
import { getEnv } from "../config/env";

const globalForGatewayPrisma = globalThis as unknown as {
  llmGatewayPrisma?: GatewayPrismaClient;
  llmGatewayPool?: Pool;
};

/** Lazily construct the standalone service's only database client. */
const createGatewayPrisma = () => {
  const env = getEnv();

  const pool = new Pool({
    connectionString: env.GATEWAY_DATABASE_URL,
    ssl:
      env.GATEWAY_DATABASE_SSL_MODE === "disable"
        ? false
        : {
            rejectUnauthorized: env.GATEWAY_DATABASE_SSL_MODE === "verify-full",
          },
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  globalForGatewayPrisma.llmGatewayPool = pool;

  return new PrismaClient({ adapter: new PrismaPg(pool) });
};

export const getLlmGatewayPrisma = (): GatewayPrismaClient => {
  globalForGatewayPrisma.llmGatewayPrisma ??= createGatewayPrisma();

  return globalForGatewayPrisma.llmGatewayPrisma;
};

export const llmGatewayPrisma: GatewayPrismaClient = new Proxy(
  {} as GatewayPrismaClient,
  {
    get(_target, prop) {
      const client = getLlmGatewayPrisma();
      const value = Reflect.get(client, prop) as unknown;

      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(client)
        : value;
    },
  },
);

export const closeLlmGatewayDatabase = async (): Promise<void> => {
  const client = globalForGatewayPrisma.llmGatewayPrisma;
  const pool = globalForGatewayPrisma.llmGatewayPool;

  globalForGatewayPrisma.llmGatewayPrisma = undefined;
  globalForGatewayPrisma.llmGatewayPool = undefined;
  await client?.$disconnect().catch(() => undefined);
  await pool?.end().catch(() => undefined);
};

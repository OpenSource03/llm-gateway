import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import type { PrismaClient as GatewayPrismaClient } from "../generated/prisma/client";

import { PrismaClient } from "../generated/prisma/client";
import { getEnv } from "../config/env";
import Logger from "../config/logger";

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
  pool.on("error", () => {
    Logger.error("Gateway database idle connection failed", {
      totalConnections: pool.totalCount,
      waitingClients: pool.waitingCount,
    });
  });

  return new PrismaClient({ adapter: new PrismaPg(pool) }).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const startedAt = performance.now();
          try {
            const result = await query(args);
            const durationMs = Math.round(performance.now() - startedAt);
            if (durationMs >= 250)
              Logger.warn("Gateway database operation slow", {
                model,
                operation,
                durationMs,
              });
            return result;
          } catch (error) {
            const code =
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string" &&
              /^P\d{4}$/.test(error.code)
                ? error.code
                : "DATABASE_ERROR";
            Logger.error("Gateway database operation failed", {
              model,
              operation,
              code,
              durationMs: Math.round(performance.now() - startedAt),
            });
            throw error;
          }
        },
      },
    },
  }) as unknown as GatewayPrismaClient;
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

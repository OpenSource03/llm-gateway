import { serve } from "@hono/node-server";

import Logger from "./config/logger";
import { getEnv } from "./config/env";
import { buildControlApp, buildDataApp } from "./http/apps";
import { buildHealthRoutes } from "./http/health";
import { closeLlmGatewayDatabase } from "./core/db";
import { touchGatewayScheduler } from "./core/scheduler";

const env = getEnv();
const servers: Array<ReturnType<typeof serve>> = [];

const listen = (
  name: string,
  fetch: (request: Request) => Response | Promise<Response>,
  hostname: string,
  port: number,
) => {
  const server = serve({ fetch, hostname, port });

  Logger.info(`${name} server listening`, {
    hostname,
    port,
    role: env.GATEWAY_ROLE,
  });
  servers.push(server);

  return server;
};

if (env.GATEWAY_ROLE === "data" || env.GATEWAY_ROLE === "all") {
  listen(
    "data",
    buildDataApp().fetch,
    env.GATEWAY_DATA_HOST,
    env.GATEWAY_DATA_PORT,
  );
}

if (env.GATEWAY_ROLE === "control" || env.GATEWAY_ROLE === "all") {
  listen(
    "control",
    buildControlApp().fetch,
    env.GATEWAY_CONTROL_HOST,
    env.GATEWAY_CONTROL_PORT,
  );
}

if (env.GATEWAY_ROLE === "worker" || env.GATEWAY_ROLE === "all") {
  touchGatewayScheduler();
  if (env.GATEWAY_ROLE === "worker") {
    listen(
      "worker-health",
      buildHealthRoutes(true).fetch,
      env.GATEWAY_CONTROL_HOST,
      env.GATEWAY_CONTROL_PORT,
    );
  }
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  Logger.info("Gateway shutdown started", { signal });
  // Inference may run for ten minutes. Let accepted streams finish before
  // closing the database; deployment stop timeouts must allow this drain.
  const deadline = setTimeout(() => process.exit(1), 11 * 60_000);

  deadline.unref();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await closeLlmGatewayDatabase();
  clearTimeout(deadline);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

import { Hono } from "hono";
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "@prometheus-io/client";

import { getEnv } from "../config/env";
import { llmGatewayPrisma } from "../core/db";

const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "llm_gateway_" });

const requests = new Counter({
  name: "llm_gateway_http_requests_total",
  help: "Completed HTTP dispatches without route or tenant cardinality",
  labelNames: ["surface", "method", "status"] as const,
  registers: [registry],
});
const dispatchDuration = new Histogram({
  name: "llm_gateway_http_dispatch_seconds",
  help: "Time until the gateway constructs an HTTP response",
  labelNames: ["surface", "method"] as const,
  registers: [registry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const observeHttpDispatch = (
  surface: "data" | "control",
  method: string,
  status: number,
  elapsedMs: number,
): void => {
  requests.inc({ surface, method, status: String(status) });
  dispatchDuration.observe({ surface, method }, elapsedMs / 1_000);
};

export const buildHealthRoutes = (includeMetrics: boolean): Hono => {
  const routes = new Hono();

  routes.get("/health/live", (context) =>
    context.json({ status: "ok", role: getEnv().GATEWAY_ROLE }),
  );
  routes.get("/health/ready", async (context) => {
    try {
      await llmGatewayPrisma.$queryRaw`SELECT 1`;
      const externalAccounts =
        await llmGatewayPrisma.gatewayProviderAccount.count({
          where: { enabled: true, transportMode: "agent-sdk" },
        });

      if (externalAccounts > 0) {
        const env = getEnv();

        if (
          !env.GATEWAY_ANTHROPIC_AGENT_SDK_URL ||
          !env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY
        ) {
          return context.json(
            { status: "not-ready", dependency: "agent-sdk" },
            503,
          );
        }
        const response = await fetch(
          new URL("/health", env.GATEWAY_ANTHROPIC_AGENT_SDK_URL),
          {
            headers: {
              Authorization: `Bearer ${env.GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY}`,
            },
            redirect: "error",
            signal: AbortSignal.timeout(2_000),
          },
        );

        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) {
          return context.json(
            { status: "not-ready", dependency: "agent-sdk" },
            503,
          );
        }
      }

      return context.json({ status: "ready" });
    } catch {
      return context.json({ status: "not-ready" }, 503);
    }
  });
  if (includeMetrics) {
    routes.get("/metrics", async (context) => {
      context.header("content-type", registry.contentType);

      return context.body(await registry.metrics());
    });
  }

  return routes;
};

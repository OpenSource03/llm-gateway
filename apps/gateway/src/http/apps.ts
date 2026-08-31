import type { ControlVariables } from "../middleware/control-principal";

import { Hono } from "hono";

import { getEnv } from "../config/env";
import { gatewayAuditMiddleware } from "../core/gateway-audit";
import dataPlaneRoutes from "../core/data-plane.routes";
import {
  requireControlAuthentication,
  requireControlScope,
} from "../middleware/control-auth";
import { limitControlRequestBody } from "../middleware/control-body-limit";
import controlRoutes from "../control/routes";

import { controlErrorHandler } from "./error-handler";
import { buildHealthRoutes, observeHttpDispatch } from "./health";

export const buildDataApp = (): Hono => {
  const app = new Hono();
  const legacy = getEnv().GATEWAY_LEGACY_BASE_PATH.replace(/\/$/, "");

  app.use("*", async (context, next) => {
    const startedAt = performance.now();

    await next();
    observeHttpDispatch(
      "data",
      context.req.method,
      context.res.status,
      performance.now() - startedAt,
    );
  });
  app.route("/", buildHealthRoutes(false));
  app.route("/", dataPlaneRoutes);
  if (legacy) app.route(legacy, dataPlaneRoutes);

  return app;
};

export const buildControlApp = (): Hono<{ Variables: ControlVariables }> => {
  const app = new Hono<{ Variables: ControlVariables }>();

  app.onError(controlErrorHandler);
  app.use("*", async (context, next) => {
    const startedAt = performance.now();

    await next();
    observeHttpDispatch(
      "control",
      context.req.method,
      context.res.status,
      performance.now() - startedAt,
    );
  });
  app.route("/", buildHealthRoutes(true));
  app.use("/admin/v1/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store, max-age=0");
    context.header("Pragma", "no-cache");
  });
  app.use("/admin/v1/*", requireControlAuthentication);
  app.use("/admin/v1/*", requireControlScope);
  app.use("/admin/v1/*", limitControlRequestBody);
  app.use("/admin/v1/*", gatewayAuditMiddleware);
  app.route("/admin/v1", controlRoutes);

  return app;
};

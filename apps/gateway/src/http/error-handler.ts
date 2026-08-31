import type { ErrorHandler } from "hono";

import Logger from "../config/logger";
import {
  GatewayError,
  isGatewayError,
  retryAfterSeconds,
} from "../core/errors";

export const controlErrorHandler: ErrorHandler = (error, context) => {
  const publicError = isGatewayError(error)
    ? error
    : new GatewayError("Internal gateway error", 503, "GATEWAY_INTERNAL");
  const retryAfter = retryAfterSeconds(publicError.retryAt);

  if (!isGatewayError(error)) {
    Logger.error("Unhandled control-plane error", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
  context.header("Cache-Control", "private, no-store, max-age=0");
  context.header("Pragma", "no-cache");
  if (retryAfter !== null) context.header("Retry-After", String(retryAfter));

  return context.json(
    {
      success: false,
      error: {
        message: publicError.message,
        code: publicError.code,
      },
    },
    publicError.status,
  );
};

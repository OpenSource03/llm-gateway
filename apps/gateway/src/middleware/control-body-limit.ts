import { createMiddleware } from "hono/factory";

import { GatewayError } from "../core/errors";
import { readBoundedRequestBody } from "../core/read-bounded-body";

export const MAX_CONTROL_REQUEST_BYTES = 256 * 1024;

/**
 * Bound and replay a control request after authentication but before audit or
 * JSON parsing. This keeps rejected anonymous requests from consuming body
 * bandwidth and guarantees the audit middleware only clones bounded input.
 */
export const limitControlRequestBody = createMiddleware(
  async (context, next) => {
    const request = context.req.raw;

    if (!request.body) return next();
    const declaredLength = Number(request.headers.get("content-length") ?? 0);

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CONTROL_REQUEST_BYTES
    ) {
      await request.body
        .cancel("Control request exceeded the gateway limit")
        .catch(() => undefined);
      throw new GatewayError(
        "Control request body is too large",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
    const body = await readBoundedRequestBody(
      request,
      MAX_CONTROL_REQUEST_BYTES,
    );

    context.req.raw = new Request(request, {
      body,
      // Node requires duplex for streaming request reconstruction. The bounded
      // body itself is already fully buffered at this point.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await next();
  },
);

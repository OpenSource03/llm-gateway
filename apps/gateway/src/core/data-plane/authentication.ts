import type { GatewayClientPrincipal } from "../../control/client-keys.service";

import { authenticateGatewayClientKey } from "../../control/client-keys.service";
import { AuthFailureRateLimiter } from "../auth-failure-rate-limit";
import { GatewayError } from "../errors";
import { SHARED_PUBLIC_AUTH_BUCKET } from "../public-client-address";

const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_MAX_KEYS = 4_096;

const authFailures = new AuthFailureRateLimiter({
  limit: AUTH_FAILURE_LIMIT,
  maxKeys: AUTH_FAILURE_MAX_KEYS,
  windowMs: AUTH_FAILURE_WINDOW_MS,
});

export interface AuthenticatedGatewayRequest {
  principal: GatewayClientPrincipal;
}

export const authenticateDataPlaneRequest = async (
  authorization: string | undefined,
  clientAddress = SHARED_PUBLIC_AUTH_BUCKET,
): Promise<AuthenticatedGatewayRequest> => {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  const retryAt = authFailures.retryAt(clientAddress);

  // A shared fallback bucket must not let unauthenticated traffic lock out a
  // valid key globally. Bearer-shaped credentials are therefore still checked
  // while that bucket is limited; Azure's edge remains the authoritative
  // request-rate control in the fallback topology.
  if (retryAt && (clientAddress !== SHARED_PUBLIC_AUTH_BUCKET || !match)) {
    throw new GatewayError(
      "Too many failed authentication attempts",
      429,
      "AUTH_RATE_LIMITED",
      retryAt,
    );
  }

  try {
    if (!match) {
      throw new GatewayError(
        "Gateway key required",
        401,
        "GATEWAY_KEY_REQUIRED",
      );
    }
    const presentedKey = match[1]!.trim();
    const principal = await authenticateGatewayClientKey(presentedKey);

    if (clientAddress !== SHARED_PUBLIC_AUTH_BUCKET) {
      authFailures.recordSuccess(clientAddress);
    }

    return { principal };
  } catch (error) {
    authFailures.recordFailure(clientAddress);
    const activeRetryAt = authFailures.retryAt(clientAddress);

    if (activeRetryAt) {
      throw new GatewayError(
        "Too many failed authentication attempts",
        429,
        "AUTH_RATE_LIMITED",
        activeRetryAt,
      );
    }
    throw error;
  }
};

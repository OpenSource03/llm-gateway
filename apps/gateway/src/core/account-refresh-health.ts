import { GatewayError } from "./errors";
import { ProviderProtocolError } from "./providers/shared";

export interface GatewayAccountRefreshHealth {
  status: "REAUTH_REQUIRED" | "ERROR";
  healthReason:
    | "Provider rejected the OAuth session"
    | "Provider refresh temporarily unavailable"
    | "Provider refresh failed";
}

const providerStatus = (error: unknown): number | undefined =>
  error instanceof ProviderProtocolError ? error.status : undefined;

const requiresReauthentication = (error: unknown): boolean => {
  if (
    error instanceof GatewayError &&
    error.code === "ACCOUNT_REAUTH_REQUIRED"
  ) {
    return true;
  }
  const status = providerStatus(error);

  return status === 400 || status === 401;
};

const isTransientProviderFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if (
    error instanceof ProviderProtocolError &&
    error.message === "Provider request timed out"
  ) {
    return true;
  }
  const status = providerStatus(error);

  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
};

/** Reduce provider failures to a stable account state without persisting raw text. */
export function classifyAccountRefreshFailures(
  failures: readonly unknown[],
): GatewayAccountRefreshHealth {
  if (failures.some(requiresReauthentication)) {
    return {
      status: "REAUTH_REQUIRED",
      healthReason: "Provider rejected the OAuth session",
    };
  }
  if (failures.length > 0 && failures.every(isTransientProviderFailure)) {
    return {
      status: "ERROR",
      healthReason: "Provider refresh temporarily unavailable",
    };
  }

  return { status: "ERROR", healthReason: "Provider refresh failed" };
}

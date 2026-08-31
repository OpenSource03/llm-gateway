const GATEWAY_ERROR_BRAND = Symbol.for("llm-gateway.error");

export class GatewayError extends Error {
  readonly [GATEWAY_ERROR_BRAND] = true;

  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 408 | 409 | 413 | 429 | 502 | 503,
    readonly code: string,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const isGatewayError = (error: unknown): error is GatewayError =>
  error instanceof GatewayError ||
  (Boolean(error) &&
    typeof error === "object" &&
    (error as Record<PropertyKey, unknown>)[GATEWAY_ERROR_BRAND] === true &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string");

export const retryAfterSeconds = (
  retryAt: Date | undefined,
  now = new Date(),
): number | null =>
  retryAt
    ? Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000))
    : null;

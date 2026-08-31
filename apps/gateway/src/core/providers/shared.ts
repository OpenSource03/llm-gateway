import type {
  AdapterDependencies,
  ProviderFailure,
  ProviderIdentity,
  QuotaWindow,
} from "./types";

import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_ADAPTER_DEPENDENCIES: AdapterDependencies = {
  fetch,
  now: Date.now,
  randomUUID,
};

export class ProviderProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

export function assertRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value))
    throw new ProviderProtocolError(`${label} was not a JSON object`);

  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();

  return normalized.length > 0 ? normalized : undefined;
}

export const MAX_PROVIDER_MODEL_ROWS = 2_000;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 1_024;

const MODEL_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Provider model ids become public selectors, so reject unsafe spellings. */
export function providerModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();

  if (
    !normalized ||
    normalized !== value ||
    normalized.length > MAX_PROVIDER_MODEL_ID_LENGTH ||
    MODEL_ID_CONTROL_CHARACTERS.test(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

export function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function quotaStatus(
  usedFraction: number | undefined,
): QuotaWindow["status"] {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";

  return "ok";
}

export function parseRetryAfter(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const raw = headers.get("retry-after")?.trim();

  if (!raw) return undefined;
  const seconds = Number(raw);

  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(raw);

  if (!Number.isFinite(timestamp)) return undefined;

  return Math.max(0, timestamp - now);
}

export function classifyHttpFailure(
  status: number,
  headers: Headers,
  body?: unknown,
): ProviderFailure {
  const retryAfterMs = parseRetryAfter(headers);
  const text =
    typeof body === "string"
      ? body.toLowerCase()
      : JSON.stringify(body ?? "").toLowerCase();

  if (status === 401) {
    return {
      kind: "authentication",
      retryable: true,
      reauthenticate: true,
      status,
    };
  }
  if (status === 403) {
    return {
      kind: "invalid-request",
      retryable: false,
      reauthenticate: false,
      status,
    };
  }
  if (status === 429) {
    const quota = /quota|usage.?limit|limit.?reached|exhaust/.test(text);

    return {
      kind: quota ? "quota" : "rate-limit",
      retryable: true,
      reauthenticate: false,
      retryAfterMs,
      status,
    };
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return {
      kind: "transient",
      retryable: true,
      reauthenticate: false,
      retryAfterMs,
      status,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      kind: "invalid-request",
      retryable: false,
      reauthenticate: false,
      status,
    };
  }

  return { kind: "unknown", retryable: false, reauthenticate: false, status };
}

export function validateFixedHttpsUrl(
  raw: string,
  allowedHosts: readonly string[],
  label: string,
): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new ProviderProtocolError(`Invalid ${label}`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new ProviderProtocolError(`Invalid ${label}`);
  }

  return url.toString();
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = new ProviderProtocolError("Provider request timed out");
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  };

  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.body) {
      cleanup();

      return response;
    }
    const reader = response.body.getReader();
    let terminated = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const release = () => {
      try {
        reader.releaseLock();
      } catch {
        // A concurrent read can retain the lock until its promise settles.
      }
    };
    const abortBody = () => {
      if (terminated) return;
      terminated = true;
      const reason = controller.signal.reason ?? timeoutError;

      bodyController?.error(reason);
      void reader
        .cancel(reason)
        .catch(() => undefined)
        .finally(() => {
          release();
          cleanup();
        });
    };

    controller.signal.addEventListener("abort", abortBody, { once: true });
    const finishBody = () => {
      if (terminated) return;
      terminated = true;
      controller.signal.removeEventListener("abort", abortBody);
      release();
      cleanup();
    };
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        bodyController = streamController;
        if (controller.signal.aborted) abortBody();
      },
      async pull(streamController) {
        if (terminated) return;
        try {
          const result = await reader.read();

          if (terminated) return;
          if (result.done) {
            finishBody();
            streamController.close();
          } else {
            streamController.enqueue(result.value);
          }
        } catch (error) {
          finishBody();
          streamController.error(error);
        }
      },
      async cancel(reason) {
        if (terminated) return;
        terminated = true;
        controller.signal.removeEventListener("abort", abortBody);
        try {
          await reader.cancel(reason);
        } finally {
          release();
          cleanup();
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function readBoundedText(
  response: Response,
  maxBytes = 256 * 1024,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new ProviderProtocolError(
          "Provider response exceeded the size limit",
        );
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();

    return output;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes = 256 * 1024,
): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes);

  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderProtocolError(
      "Provider returned invalid JSON",
      response.status,
    );
  }
}

export async function expectJson(
  response: Response,
  label: string,
  maxBytes = 256 * 1024,
): Promise<unknown> {
  if (!response.ok) {
    // Drain a bounded amount so the connection can be reused, but never copy
    // provider-controlled OAuth/device/token bodies into exceptions or logs.
    await readBoundedText(response, 64 * 1024).catch(() => "");

    throw new ProviderProtocolError(
      `${label} failed with HTTP ${response.status}`,
      response.status,
      parseRetryAfter(response.headers),
    );
  }

  return readBoundedJson(response, maxBytes);
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  const parts = token.split(".");

  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function identityFromJwtSubject(token: string): ProviderIdentity | null {
  const payload = decodeJwtPayload(token);
  const subject = nonEmptyString(payload?.sub);

  if (!subject) return null;

  return {
    externalAccountId: subject,
    email: nonEmptyString(payload?.email)?.toLowerCase(),
    displayName: nonEmptyString(payload?.name),
  };
}

export function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeSessionId(
  value: string | undefined,
  fallbackSeed: string,
): string {
  const normalized = value?.trim();

  if (
    normalized &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  ) {
    return normalized;
  }

  return stableUuid(normalized || fallbackSeed);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mergeHeadersForPublicResponse(
  response: Response,
  contentType: string,
): Headers {
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-type": contentType,
    pragma: "no-cache",
    vary: "Authorization",
    "x-accel-buffering": "no",
  });
  const requestId =
    response.headers.get("request-id") ?? response.headers.get("x-request-id");

  if (requestId) headers.set("request-id", requestId);

  return headers;
}

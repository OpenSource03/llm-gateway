import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { getEnv } from "../../config/env";

const GATEWAY_KEY_BYTES = 32;
const LEGACY_GATEWAY_KEY_SHAPE = /^arcgw_[a-z0-9]+_[0-9a-f]{64}$/;
const GATEWAY_KEY_SHAPE = /^llmgw_dat_[0-9a-f]{64}$/;

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const constantTimeHexEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  const a = Uint8Array.from(Buffer.from(left, "hex"));
  const b = Uint8Array.from(Buffer.from(right, "hex"));

  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

export const createGatewayClientSecret = (): {
  secret: string;
  hash: string;
  prefix: string;
} => {
  const random = randomBytes(GATEWAY_KEY_BYTES).toString("hex");
  const secret = `llmgw_dat_${random}`;

  return {
    secret,
    hash: sha256Hex(secret),
    prefix: `llmgw_dat_${random.slice(0, 8)}`,
  };
};

export const isGatewayClientSecret = (value: string): boolean =>
  GATEWAY_KEY_SHAPE.test(value) || LEGACY_GATEWAY_KEY_SHAPE.test(value);

export const hmacGatewaySession = (sessionId: string): string => {
  const secret = getEnv().GATEWAY_SESSION_HMAC_SECRET;

  if (!secret) throw new Error("LLM gateway session HMAC is not configured");

  return createHmac("sha256", secret).update(sessionId, "utf8").digest("hex");
};

export const createOpaqueSecret = (bytes = 32): string =>
  randomBytes(bytes).toString("base64url");

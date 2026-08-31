import { randomBytes } from "node:crypto";

import { sha256Hex } from "./secrets";

const CONTROL_KEY_BYTES = 32;
const CONTROL_KEY_SHAPE = /^llmgw_ctl_[0-9a-f]{64}$/;

export const createControlSecret = (): {
  secret: string;
  hash: string;
  prefix: string;
} => {
  const random = randomBytes(CONTROL_KEY_BYTES).toString("hex");
  const secret = `llmgw_ctl_${random}`;

  return {
    secret,
    hash: sha256Hex(secret),
    prefix: `llmgw_ctl_${random.slice(0, 8)}`,
  };
};

export const isControlSecret = (value: string): boolean =>
  CONTROL_KEY_SHAPE.test(value);

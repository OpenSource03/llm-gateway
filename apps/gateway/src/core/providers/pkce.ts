import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const base64Url = (value: Buffer): string => value.toString("base64url");

export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createSha256(verifier));

  return { verifier, challenge };
}

function createSha256(value: string): Buffer {
  // Kept synchronous so login state is generated atomically before persistence.
  return createHash("sha256").update(value).digest();
}

export function generateOAuthState(): string {
  return base64Url(randomBytes(32));
}

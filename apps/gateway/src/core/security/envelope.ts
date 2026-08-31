import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";

import { getEnv } from "../../config/env";

const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENCRYPTION_ALGORITHM = "AES-256-GCM+RSA-OAEP-256";

export interface WrappedKeyResult {
  wrappedKey: Uint8Array;
  keyId: string;
}

export interface KeyWrapper {
  readonly keyId: string;
  wrapKey(dataKey: Uint8Array): Promise<WrappedKeyResult>;
  unwrapKey(wrappedKey: Uint8Array, keyId: string): Promise<Uint8Array>;
}

export interface EncryptedEnvelope {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyWrapperId: string;
  encryptionAlgorithm: string;
  envelopeVersion: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CURRENT_ENVELOPE_VERSION = 2;

const aadFor = (context: string, version: number): Uint8Array => {
  if (version === 1) {
    return encoder.encode(`arcademy-llm-gateway:v1:${context}`);
  }
  if (version === CURRENT_ENVELOPE_VERSION) {
    return encoder.encode(`llm-gateway:v2:${context}`);
  }

  throw new Error("Unsupported credential envelope version");
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }

  return joined;
};

/** Encrypt a JSON value with a random per-record data key. */
export const encryptEnvelope = async (
  value: unknown,
  context: string,
  wrapper: KeyWrapper,
): Promise<EncryptedEnvelope> => {
  if (!context.trim()) throw new Error("Envelope context is required");

  const plaintext = encoder.encode(JSON.stringify(value));
  const dataKey = Uint8Array.from(randomBytes(DATA_KEY_BYTES));
  const nonce = Uint8Array.from(randomBytes(NONCE_BYTES));

  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });

    cipher.setAAD(aadFor(context, CURRENT_ENVELOPE_VERSION));
    const ciphertext = concatBytes(
      Uint8Array.from(cipher.update(plaintext)),
      Uint8Array.from(cipher.final()),
    );
    const authTag = Uint8Array.from(cipher.getAuthTag());
    const wrapped = await wrapper.wrapKey(dataKey);

    return {
      ciphertext,
      nonce,
      authTag,
      wrappedDataKey: wrapped.wrappedKey,
      keyWrapperId: wrapped.keyId,
      encryptionAlgorithm: ENCRYPTION_ALGORITHM,
      envelopeVersion: CURRENT_ENVELOPE_VERSION,
    };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
};

/** Decrypt and parse a credential/OAuth envelope, binding it to its row ID. */
export const decryptEnvelope = async <T>(
  envelope: EncryptedEnvelope,
  context: string,
  wrapper: KeyWrapper,
): Promise<T> => {
  if (envelope.encryptionAlgorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error("Unsupported credential encryption algorithm");
  }
  if (envelope.nonce.byteLength !== NONCE_BYTES) {
    throw new Error("Invalid credential nonce");
  }
  if (envelope.authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("Invalid credential authentication tag");
  }

  const dataKey = Uint8Array.from(
    await wrapper.unwrapKey(envelope.wrappedDataKey, envelope.keyWrapperId),
  );

  if (dataKey.byteLength !== DATA_KEY_BYTES) {
    dataKey.fill(0);
    throw new Error("Invalid unwrapped credential data key");
  }

  let plaintext: Uint8Array | null = null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, envelope.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });

    decipher.setAAD(aadFor(context, envelope.envelopeVersion));
    decipher.setAuthTag(Uint8Array.from(envelope.authTag));
    plaintext = concatBytes(
      Uint8Array.from(decipher.update(envelope.ciphertext)),
      Uint8Array.from(decipher.final()),
    );

    return JSON.parse(decoder.decode(plaintext)) as T;
  } finally {
    dataKey.fill(0);
    plaintext?.fill(0);
  }
};

/**
 * Rewrap only the random data key under the currently configured Key Vault
 * key. Credential plaintext and AES-GCM ciphertext never leave the database
 * process during a KEK rotation.
 */
export const rewrapEnvelopeDataKey = async (
  envelope: EncryptedEnvelope,
  wrapper: KeyWrapper,
): Promise<EncryptedEnvelope> => {
  if (envelope.encryptionAlgorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error("Unsupported credential encryption algorithm");
  }
  const dataKey = Uint8Array.from(
    await wrapper.unwrapKey(envelope.wrappedDataKey, envelope.keyWrapperId),
  );

  if (dataKey.byteLength !== DATA_KEY_BYTES) {
    dataKey.fill(0);
    throw new Error("Invalid unwrapped credential data key");
  }
  try {
    const wrapped = await wrapper.wrapKey(dataKey);

    return {
      ...envelope,
      wrappedDataKey: wrapped.wrappedKey,
      keyWrapperId: wrapped.keyId,
    };
  } finally {
    dataKey.fill(0);
  }
};

/** Azure implementation using the immutable, versioned key configured at runtime. */
export class AzureKeyVaultKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  readonly #client: CryptographyClient;

  constructor(keyId: string, managedIdentityClientId?: string) {
    this.keyId = keyId;
    const credential = new DefaultAzureCredential({
      ...(managedIdentityClientId && {
        managedIdentityClientId,
      }),
    });

    this.#client = new CryptographyClient(keyId, credential);
  }

  async wrapKey(dataKey: Uint8Array): Promise<WrappedKeyResult> {
    const result = await this.#client.wrapKey("RSA-OAEP-256", dataKey);

    return { wrappedKey: result.result, keyId: result.keyID ?? this.keyId };
  }

  async unwrapKey(wrappedKey: Uint8Array, keyId: string): Promise<Uint8Array> {
    // Old records retain their exact key version. Construct a client for that
    // immutable ID during rotation rather than accidentally using the latest.
    if (keyId !== this.keyId) {
      assertCompatibleHistoricalKeyId(this.keyId, keyId);
      const env = getEnv();
      const credential = new DefaultAzureCredential({
        ...(env.AZURE_MANAGED_IDENTITY_CLIENT_ID && {
          managedIdentityClientId: env.AZURE_MANAGED_IDENTITY_CLIENT_ID,
        }),
      });
      const historical = new CryptographyClient(keyId, credential);
      const result = await historical.unwrapKey("RSA-OAEP-256", wrappedKey);

      return result.result;
    }

    const result = await this.#client.unwrapKey("RSA-OAEP-256", wrappedKey);

    return result.result;
  }
}

/**
 * Portable key wrapper for workstations and self-hosted deployments without a
 * managed KMS. The private key remains outside the repository and only wrapped
 * random data keys are stored in PostgreSQL.
 */
export class LocalRsaKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;
  readonly #publicKey: ReturnType<typeof createPublicKey>;

  constructor(privateKeyPath: string) {
    if (!isAbsolute(privateKeyPath)) {
      throw new Error("Local gateway RSA key path must be absolute");
    }

    const resolvedPath = realpathSync(privateKeyPath);
    const stat = statSync(resolvedPath);

    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(
        "Local gateway RSA key must be a regular file readable only by its owner",
      );
    }

    this.#privateKey = createPrivateKey(readFileSync(resolvedPath));
    this.#publicKey = createPublicKey(this.#privateKey);
    const fingerprint = createHash("sha256")
      .update(
        Uint8Array.from(
          this.#publicKey.export({
            type: "spki",
            format: "der",
          }),
        ),
      )
      .digest("hex");

    this.keyId = `local-rsa-sha256:${fingerprint}`;
  }

  async wrapKey(dataKey: Uint8Array): Promise<WrappedKeyResult> {
    return {
      keyId: this.keyId,
      wrappedKey: Uint8Array.from(
        publicEncrypt(
          {
            key: this.#publicKey,
            oaepHash: "sha256",
            padding: constants.RSA_PKCS1_OAEP_PADDING,
          },
          dataKey,
        ),
      ),
    };
  }

  async unwrapKey(wrappedKey: Uint8Array, keyId: string): Promise<Uint8Array> {
    if (keyId !== this.keyId) {
      throw new Error("Credential was wrapped by a different local RSA key");
    }

    return Uint8Array.from(
      privateDecrypt(
        {
          key: this.#privateKey,
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        wrappedKey,
      ),
    );
  }
}

const parsedVersionedKeyId = (keyId: string): URL => {
  const url = new URL(keyId);
  const segments = url.pathname.split("/").filter(Boolean);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[a-z0-9-]+\.vault\.azure\.net$/i.test(url.hostname) ||
    segments.length !== 3 ||
    segments[0] !== "keys" ||
    !segments[1] ||
    !segments[2]
  ) {
    throw new Error("Invalid historical gateway Key Vault key ID");
  }

  return url;
};

/** Historical rows may change only the immutable version, never vault/key. */
export const assertCompatibleHistoricalKeyId = (
  configuredKeyId: string,
  historicalKeyId: string,
): void => {
  const configured = parsedVersionedKeyId(configuredKeyId);
  const historical = parsedVersionedKeyId(historicalKeyId);
  const configuredSegments = configured.pathname.split("/").filter(Boolean);
  const historicalSegments = historical.pathname.split("/").filter(Boolean);

  if (
    configured.hostname.toLowerCase() !== historical.hostname.toLowerCase() ||
    configuredSegments[1] !== historicalSegments[1]
  ) {
    throw new Error(
      "Historical gateway key must use the configured Key Vault and key name",
    );
  }
};

let cachedWrapper: KeyWrapper | null = null;

export const getGatewayKeyWrapper = (): KeyWrapper => {
  if (cachedWrapper) return cachedWrapper;
  const env = getEnv();

  if (env.GATEWAY_KEY_WRAPPER === "local-rsa") {
    cachedWrapper = new LocalRsaKeyWrapper(env.GATEWAY_LOCAL_RSA_KEY_PATH!);

    return cachedWrapper;
  }

  cachedWrapper = new AzureKeyVaultKeyWrapper(
    env.GATEWAY_AZURE_KEY_VAULT_KEY_ID!,
    env.AZURE_MANAGED_IDENTITY_CLIENT_ID,
  );

  return cachedWrapper;
};

export const envelopeFromRecord = (record: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyWrapperId: string;
  encryptionAlgorithm: string;
  envelopeVersion?: number;
}): EncryptedEnvelope => ({
  ciphertext: record.ciphertext,
  nonce: record.nonce,
  authTag: record.authTag,
  wrappedDataKey: record.wrappedDataKey,
  keyWrapperId: record.keyWrapperId,
  encryptionAlgorithm: record.encryptionAlgorithm,
  envelopeVersion: record.envelopeVersion ?? 1,
});

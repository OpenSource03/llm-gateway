import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  generateKeyPair,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  decryptEnvelope,
  encryptEnvelope,
  assertCompatibleHistoricalKeyId,
  LocalRsaKeyWrapper,
  rewrapEnvelopeDataKey,
  type KeyWrapper,
} from "./envelope";

const generateKeyPairAsync = promisify(generateKeyPair);

test("historical key IDs may change only the configured key version", () => {
  assert.doesNotThrow(() =>
    assertCompatibleHistoricalKeyId(
      "https://gateway-vault.vault.azure.net/keys/credentials/version-2",
      "https://gateway-vault.vault.azure.net/keys/credentials/version-1",
    ),
  );
  assert.throws(() =>
    assertCompatibleHistoricalKeyId(
      "https://gateway-vault.vault.azure.net/keys/credentials/version-2",
      "https://attacker-vault.vault.azure.net/keys/credentials/version-1",
    ),
  );
  assert.throws(() =>
    assertCompatibleHistoricalKeyId(
      "https://gateway-vault.vault.azure.net/keys/credentials/version-2",
      "https://gateway-vault.vault.azure.net/keys/other/version-1",
    ),
  );
  assert.throws(() =>
    assertCompatibleHistoricalKeyId(
      "https://gateway-vault.vault.azure.net/keys/credentials/version-2",
      "https://gateway-vault.vault.azure.net/keys/credentials/version-1?x=1",
    ),
  );
});

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

const wrapper: KeyWrapper = {
  keyId: "https://vault.test/keys/gateway/version-1",
  async wrapKey(key) {
    return {
      keyId: this.keyId,
      wrappedKey: Uint8Array.from(
        publicEncrypt(
          {
            key: pair.publicKey,
            oaepHash: "sha256",
            padding: constants.RSA_PKCS1_OAEP_PADDING,
          },
          key,
        ),
      ),
    };
  },
  async unwrapKey(key) {
    return Uint8Array.from(
      privateDecrypt(
        {
          key: pair.privateKey,
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        key,
      ),
    );
  },
};

test("envelope encryption round-trips and retains the wrapping key version", async () => {
  const value = {
    accessToken: "access",
    refreshToken: "refresh",
    expires: 123,
  };
  const encrypted = await encryptEnvelope(
    value,
    "credential:account-1",
    wrapper,
  );
  const decrypted = await decryptEnvelope<typeof value>(
    encrypted,
    "credential:account-1",
    wrapper,
  );

  assert.deepEqual(decrypted, value);
  assert.equal(encrypted.keyWrapperId, wrapper.keyId);
  assert.equal(encrypted.encryptionAlgorithm, "AES-256-GCM+RSA-OAEP-256");
  assert.equal(
    Buffer.from(encrypted.ciphertext).includes(Buffer.from("access")),
    false,
  );
});

test("row context is authenticated", async () => {
  const encrypted = await encryptEnvelope(
    { accessToken: "secret" },
    "credential:account-1",
    wrapper,
  );

  await assert.rejects(
    decryptEnvelope(encrypted, "credential:account-2", wrapper),
  );
});

test("ciphertext tampering is rejected", async () => {
  const encrypted = await encryptEnvelope(
    { accessToken: "secret" },
    "oauth:attempt-1",
    wrapper,
  );
  const tampered = {
    ...encrypted,
    ciphertext: Uint8Array.from(encrypted.ciphertext),
  };

  tampered.ciphertext[0] ^= 1;
  await assert.rejects(decryptEnvelope(tampered, "oauth:attempt-1", wrapper));
});

test("key rotation rewraps the data key without changing ciphertext", async () => {
  const nextPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const nextWrapper: KeyWrapper = {
    keyId: "https://vault.test/keys/gateway/version-2",
    async wrapKey(key) {
      return {
        keyId: this.keyId,
        wrappedKey: Uint8Array.from(
          publicEncrypt(
            {
              key: nextPair.publicKey,
              oaepHash: "sha256",
              padding: constants.RSA_PKCS1_OAEP_PADDING,
            },
            key,
          ),
        ),
      };
    },
    async unwrapKey(key, keyId) {
      const pairForKey = keyId === wrapper.keyId ? pair : nextPair;

      return Uint8Array.from(
        privateDecrypt(
          {
            key: pairForKey.privateKey,
            oaepHash: "sha256",
            padding: constants.RSA_PKCS1_OAEP_PADDING,
          },
          key,
        ),
      );
    },
  };
  const value = { refreshToken: "rotating-secret" };
  const encrypted = await encryptEnvelope(
    value,
    "credential:account-rotation",
    wrapper,
  );
  const rotated = await rewrapEnvelopeDataKey(encrypted, nextWrapper);

  assert.deepEqual(rotated.ciphertext, encrypted.ciphertext);
  assert.equal(rotated.keyWrapperId, nextWrapper.keyId);
  assert.deepEqual(
    await decryptEnvelope<typeof value>(
      rotated,
      "credential:account-rotation",
      nextWrapper,
    ),
    value,
  );
});

test("development local RSA wrapper keeps the KEK outside PostgreSQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-gateway-key-"));
  const keyPath = join(directory, "wrapper.pem");

  try {
    const { privateKey } = await generateKeyPairAsync("rsa", {
      modulusLength: 2048,
    });

    await writeFile(
      keyPath,
      String(privateKey.export({ type: "pkcs8", format: "pem" })),
      { mode: 0o600 },
    );
    const localWrapper = new LocalRsaKeyWrapper(keyPath);
    const value = { refreshToken: "local-encrypted-secret" };
    const encrypted = await encryptEnvelope(
      value,
      "credential:local-account",
      localWrapper,
    );

    assert.match(encrypted.keyWrapperId, /^local-rsa-sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      await decryptEnvelope<typeof value>(
        encrypted,
        "credential:local-account",
        localWrapper,
      ),
      value,
    );
    await assert.rejects(
      localWrapper.unwrapKey(
        encrypted.wrappedDataKey,
        "local-rsa-sha256:different",
      ),
      /different local RSA key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

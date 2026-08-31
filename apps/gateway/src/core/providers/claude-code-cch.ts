const MASK_64 = (1n << 64n) - 1n;
const PRIME_1 = 11_400_714_785_074_694_791n;
const PRIME_2 = 14_029_467_366_897_019_727n;
const PRIME_3 = 1_609_587_929_392_839_161n;
const PRIME_4 = 9_650_029_242_287_828_579n;
const PRIME_5 = 2_870_177_450_012_600_261n;
const CCH_SEED = 0x6e52736ac806831en;
const CCH_PATTERN =
  /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=([0-9a-f]{5});/;

const u64 = (value: bigint): bigint => value & MASK_64;
const rotl = (value: bigint, bits: bigint): bigint =>
  u64((value << bits) | (value >> (64n - bits)));

function read64(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;

  for (let index = 0; index < 8; index += 1)
    result |= BigInt(bytes[offset + index]) << BigInt(index * 8);

  return result;
}

function read32(bytes: Uint8Array, offset: number): bigint {
  return BigInt(
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
      0,
  );
}

function round(accumulator: bigint, input: bigint): bigint {
  return u64(rotl(u64(accumulator + u64(input * PRIME_2)), 31n) * PRIME_1);
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
  return u64((accumulator ^ round(0n, value)) * PRIME_1 + PRIME_4);
}

/**
 * Dependency-free xxHash64 used by the legacy observed Claude Code CCH
 * profile. Native 2.1.247 uses a newer private signing profile; keep this
 * implementation deterministic, but do not claim its output is native-current.
 */
export function xxhash64(bytes: Uint8Array, seed = 0n): bigint {
  let offset = 0;
  let hash: bigint;

  if (bytes.length >= 32) {
    let v1 = u64(seed + PRIME_1 + PRIME_2);
    let v2 = u64(seed + PRIME_2);
    let v3 = seed;
    let v4 = u64(seed - PRIME_1);
    const limit = bytes.length - 32;

    while (offset <= limit) {
      v1 = round(v1, read64(bytes, offset));
      v2 = round(v2, read64(bytes, offset + 8));
      v3 = round(v3, read64(bytes, offset + 16));
      v4 = round(v4, read64(bytes, offset + 24));
      offset += 32;
    }
    hash = u64(rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n));
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = u64(seed + PRIME_5);
  }
  hash = u64(hash + BigInt(bytes.length));
  while (offset + 8 <= bytes.length) {
    const k1 = round(0n, read64(bytes, offset));

    hash = u64(rotl(hash ^ k1, 27n) * PRIME_1 + PRIME_4);
    offset += 8;
  }
  if (offset + 4 <= bytes.length) {
    hash = u64(
      rotl(hash ^ u64(read32(bytes, offset) * PRIME_1), 23n) * PRIME_2 +
        PRIME_3,
    );
    offset += 4;
  }
  while (offset < bytes.length) {
    hash = u64(
      rotl(hash ^ u64(BigInt(bytes[offset]) * PRIME_5), 11n) * PRIME_1,
    );
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = u64(hash * PRIME_2);
  hash ^= hash >> 29n;
  hash = u64(hash * PRIME_3);
  hash ^= hash >> 32n;

  return u64(hash);
}

export function signClaudeCodeRequestBody(body: string): string {
  if (!CCH_PATTERN.test(body)) return body;
  const unsigned = body.replace(CCH_PATTERN, "$1cch=00000;");
  const token = (
    xxhash64(new TextEncoder().encode(unsigned), CCH_SEED) & 0xfffffn
  )
    .toString(16)
    .padStart(5, "0");

  return unsigned.replace(CCH_PATTERN, `$1cch=${token};`);
}

export function extractCch(body: string): string | null {
  return CCH_PATTERN.exec(body)?.[2] ?? null;
}

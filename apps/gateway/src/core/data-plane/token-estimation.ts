import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { CodexResponsesRequest } from "../wire/codex-responses";

export const estimateGatewayInputTokens = (
  request: AnthropicMessagesRequest,
): { conservative: number; approximate: number } => {
  const text = JSON.stringify({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });
  const bytes = Buffer.byteLength(text, "utf8");

  return {
    // Byte length plus framing is a tokenizer-independent upper bound suitable
    // for enforcing hard client/account caps before concurrent dispatches.
    conservative: Math.max(1, bytes + 256),
    // This conventional estimate is suitable for advisory token-count
    // responses. It must not be used to enforce provider context limits:
    // serialized byte size can diverge substantially from provider tokenization.
    approximate: Math.max(1, Math.ceil(bytes / 4) + 64),
  };
};

interface ImageDimensions {
  width: number;
  height: number;
}

const UNKNOWN_IMAGE_TOKEN_ESTIMATE = 10_000;
const IMAGE_PATCH_SIZE = 32;
const IMAGE_PATCH_TOKEN_MULTIPLIER = 1.2;

const validImageDimensions = (
  width: number,
  height: number,
): ImageDimensions | null =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;

const jpegDimensions = (data: Buffer): ImageDimensions | null => {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;

  while (offset + 8 < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;
    const marker = data[offset++];

    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const segmentLength = data.readUInt16BE(offset);

    if (segmentLength < 2 || offset + segmentLength > data.length) return null;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return validImageDimensions(
        data.readUInt16BE(offset + 5),
        data.readUInt16BE(offset + 3),
      );
    }
    offset += segmentLength;
  }

  return null;
};

const webpDimensions = (data: Buffer): ImageDimensions | null => {
  if (
    data.length < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = data.toString("ascii", 12, 16);

  if (chunk === "VP8X") {
    return validImageDimensions(
      data.readUIntLE(24, 3) + 1,
      data.readUIntLE(27, 3) + 1,
    );
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const b1 = data[21]!;
    const b2 = data[22]!;
    const b3 = data[23]!;
    const b4 = data[24]!;

    return validImageDimensions(
      1 + b1 + ((b2 & 0x3f) << 8),
      1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    );
  }
  if (
    chunk === "VP8 " &&
    data[23] === 0x9d &&
    data[24] === 0x01 &&
    data[25] === 0x2a
  ) {
    return validImageDimensions(
      data.readUInt16LE(26) & 0x3fff,
      data.readUInt16LE(28) & 0x3fff,
    );
  }

  return null;
};

const imageDimensions = (data: Buffer): ImageDimensions | null => {
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return validImageDimensions(data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if (
    data.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))
  ) {
    return validImageDimensions(data.readUInt16LE(6), data.readUInt16LE(8));
  }

  return jpegDimensions(data) ?? webpDimensions(data);
};

const inlineImageDimensions = (imageUrl: string): ImageDimensions | null => {
  const comma = imageUrl.indexOf(",");

  if (comma < 0) return null;
  const header = imageUrl.slice(0, comma).toLowerCase();

  if (!header.startsWith("data:image/") || !header.endsWith(";base64"))
    return null;

  return imageDimensions(Buffer.from(imageUrl.slice(comma + 1), "base64"));
};

const estimateImageTokens = (imageUrl: string, detail: unknown): number => {
  const dimensions = inlineImageDimensions(imageUrl);

  if (!dimensions) return UNKNOWN_IMAGE_TOKEN_ESTIMATE;
  const normalizedDetail =
    detail === "low" || detail === "high" || detail === "original"
      ? detail
      : "auto";
  const maximumDimension =
    normalizedDetail === "low"
      ? 512
      : normalizedDetail === "high"
        ? 2_048
        : null;
  const scale = maximumDimension
    ? Math.min(
        1,
        maximumDimension / dimensions.width,
        maximumDimension / dimensions.height,
      )
    : 1;
  const width = Math.max(1, Math.floor(dimensions.width * scale));
  const height = Math.max(1, Math.floor(dimensions.height * scale));
  let patches =
    Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE);

  if (normalizedDetail === "low") patches = Math.min(patches, 256);
  if (normalizedDetail === "high") patches = Math.min(patches, 2_500);

  return Math.ceil(patches * IMAGE_PATCH_TOKEN_MULTIPLIER);
};

export const estimateGatewayResponsesInputTokens = (
  request: CodexResponsesRequest,
): { conservative: number; approximate: number } => {
  let imageTokens = 0;
  const text = JSON.stringify(
    {
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
    },
    function (this: unknown, key, value) {
      if (key !== "image_url" || typeof value !== "string") return value;
      const parent =
        this && typeof this === "object" && !Array.isArray(this)
          ? (this as Record<string, unknown>)
          : null;

      imageTokens += estimateImageTokens(value, parent?.detail);

      return "[image input]";
    },
  );
  const bytes = Buffer.byteLength(text, "utf8");

  return {
    conservative: Math.max(1, bytes + 256 + imageTokens),
    approximate: Math.max(1, Math.ceil(bytes / 4) + 64 + imageTokens),
  };
};

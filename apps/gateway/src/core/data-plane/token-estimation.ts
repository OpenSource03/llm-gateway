import type { AnthropicMessagesRequest } from "../wire/anthropic";
import type { CodexResponsesRequest } from "../wire/codex-responses";
import { imageDimensions, type ImageDimensions } from "../images/image-format";

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

const UNKNOWN_IMAGE_TOKEN_ESTIMATE = 10_000;
const IMAGE_PATCH_SIZE = 32;
const IMAGE_PATCH_TOKEN_MULTIPLIER = 1.2;

const inlineImageDimensions = (imageUrl: string): ImageDimensions | null => {
  const comma = imageUrl.indexOf(",");

  if (comma < 0) return null;
  const header = imageUrl.slice(0, comma).toLowerCase();

  // Codex may label inline images generically; the bytes decide.
  if (!header.startsWith("data:") || !header.endsWith(";base64")) return null;

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

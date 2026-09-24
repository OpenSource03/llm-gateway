import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicToolResultBlock,
} from "../wire/anthropic";
import {
  imageDimensions,
  sniffImageMediaType,
  type ImageMediaType,
} from "./image-format";

// Anthropic rejects any image over 2000 px per side once a request carries more
// than 20 images; Claude Code resizes to that ceiling, but not images nested in
// tool results, which is how Codex returns screenshots. Output is deterministic
// so a thread's history stays byte-identical and keeps its prompt cache.
export const MAX_IMAGE_EDGE = 2_000;
// Smaller images pass through untouched; larger ones are re-encoded as WebP,
// about a quarter of a PNG screenshot's size.
export const REENCODE_ABOVE_BYTES = 256 * 1024;
// Raw bytes that stay under Claude Code's 5 MB base64 ceiling.
export const MAX_IMAGE_BYTES = 3_932_160;
// Request limits: 32 MB per request and, for 200k-context models, 100 images.
// Images get most of the byte budget; the rest is left for text.
export const REQUEST_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;
export const REQUEST_IMAGE_LIMIT = 100;
// Oldest images are dropped in whole groups so the history changes rarely.
export const OMIT_GROUP_SIZE = 20;
const MAX_INPUT_PIXELS = 8_000 * 8_000;
const RESIZE_TIMEOUT_SECONDS = 10;
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_RESIZES = 2;

// libvips' operation cache would keep decoded screenshots resident; results are
// cached below by input digest instead.
sharp.cache(false);

type FittedImage =
  | { kind: "image"; mediaType: ImageMediaType; data: string }
  | { kind: "omitted"; reason: string };

export const UNREADABLE_IMAGE_TEXT =
  "[Image omitted by the gateway: it is not a readable PNG, JPEG, GIF or WebP image.]";
export const TOO_LARGE_IMAGE_TEXT =
  "[Image omitted by the gateway: it stays over the provider's per-image size limit after resizing.]";
export const OMITTED_FOR_SIZE_TEXT =
  "[Earlier image omitted by the gateway to keep the request within the provider's size limits.]";

// Re-encoded results by input digest, least recently used first.
const cache = new Map<string, FittedImage>();
let cachedBytes = 0;

const cacheSize = (value: FittedImage): number =>
  value.kind === "image" ? value.data.length : 0;

const remember = (key: string, value: FittedImage): void => {
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cachedBytes -= cacheSize(previous);
  }
  cache.set(key, value);
  cachedBytes += cacheSize(value);
  for (const [oldest, entry] of cache) {
    if (cachedBytes <= CACHE_BUDGET_BYTES) break;
    cache.delete(oldest);
    cachedBytes -= cacheSize(entry);
  }
};

const recall = (key: string): FittedImage | undefined => {
  const value = cache.get(key);
  if (value) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
};

// Decoding a 20-megapixel screenshot takes ~90 MB, so few run at once.
let activeResizes = 0;
const waiting: Array<() => void> = [];
const withResizeSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  // A finishing resize hands its slot straight to the next waiter.
  if (activeResizes >= MAX_CONCURRENT_RESIZES)
    await new Promise<void>((resolve) => waiting.push(resolve));
  else activeResizes += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeResizes -= 1;
  }
};
// Concurrent requests for the same screenshot share one encode.
const inFlight = new Map<string, Promise<FittedImage>>();

class ImageTooLargeError extends Error {}

const encode = async (input: Buffer): Promise<Buffer> => {
  const fitted = () =>
    sharp(input, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .timeout({ seconds: RESIZE_TIMEOUT_SECONDS });
  const webp = await fitted().webp({ quality: 85 }).toBuffer();
  if (webp.length <= MAX_IMAGE_BYTES) return webp;
  const smaller = await fitted().webp({ quality: 60 }).toBuffer();
  if (smaller.length <= MAX_IMAGE_BYTES) return smaller;
  throw new ImageTooLargeError();
};

const encodeFitted = async (data: string): Promise<FittedImage> => {
  try {
    const output = await withResizeSlot(() =>
      encode(Buffer.from(data, "base64")),
    );

    return {
      kind: "image",
      mediaType: "image/webp",
      data: output.toString("base64"),
    };
  } catch (error) {
    return {
      kind: "omitted",
      reason:
        error instanceof ImageTooLargeError
          ? TOO_LARGE_IMAGE_TEXT
          : UNREADABLE_IMAGE_TEXT,
    };
  }
};

// 64 KiB of image bytes: enough for every format's header in practice.
const HEADER_BASE64_CHARS = 87_384;

const decodedLength = (base64: string): number =>
  Math.floor((base64.length * 3) / 4) -
  (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

const fitBase64 = async (
  data: string,
  declared: string | undefined,
): Promise<FittedImage | null> => {
  // Codex resends every image each turn; the header is enough to decide.
  const head = Buffer.from(data.slice(0, HEADER_BASE64_CHARS), "base64");
  const mediaType = sniffImageMediaType(head);

  if (!mediaType) return { kind: "omitted", reason: UNREADABLE_IMAGE_TEXT };
  const size = imageDimensions(head);

  if (
    size &&
    Math.max(size.width, size.height) <= MAX_IMAGE_EDGE &&
    decodedLength(data) <= REENCODE_ABOVE_BYTES
  ) {
    // Already small: untouched unless the declared type was wrong.
    return declared === mediaType ? null : { kind: "image", mediaType, data };
  }
  const key = createHash("sha256").update(data).digest("hex");
  const cached = recall(key);

  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = encodeFitted(data)
    .then((fitted) => {
      remember(key, fitted);
      return fitted;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, work);

  return work;
};

const fitImageBlock = async (
  block: AnthropicImageBlock,
): Promise<AnthropicContentBlock> => {
  if (block.source.type !== "base64" || !block.source.data) return block;
  const fitted = await fitBase64(block.source.data, block.source.media_type);

  if (!fitted) return block;
  if (fitted.kind === "omitted") return { type: "text", text: fitted.reason };

  return {
    ...block,
    source: { type: "base64", media_type: fitted.mediaType, data: fitted.data },
  };
};

const isImageBlock = (
  block: AnthropicContentBlock,
): block is AnthropicImageBlock => block.type === "image";

const isToolResultBlock = (
  block: AnthropicContentBlock,
): block is AnthropicToolResultBlock => block.type === "tool_result";

type ImageMapper = (
  block: AnthropicImageBlock,
) => Promise<AnthropicContentBlock>;

const mapBlocks = async (
  blocks: AnthropicContentBlock[],
  map: ImageMapper,
  signal: AbortSignal | undefined,
): Promise<AnthropicContentBlock[]> => {
  const mapped: AnthropicContentBlock[] = [];

  // Sequential on purpose: each resize may hold a large decoded bitmap.
  for (const block of blocks) {
    signal?.throwIfAborted();
    if (isImageBlock(block)) mapped.push(await map(block));
    else if (isToolResultBlock(block) && Array.isArray(block.content))
      mapped.push({
        ...block,
        content: await mapBlocks(block.content, map, signal),
      });
    else mapped.push(block);
  }
  return mapped;
};

const mapImages = async (
  request: AnthropicMessagesRequest,
  map: ImageMapper,
  signal: AbortSignal | undefined,
): Promise<AnthropicMessagesRequest> => {
  const messages: AnthropicMessagesRequest["messages"] = [];

  for (const message of request.messages)
    messages.push(
      typeof message.content === "string"
        ? message
        : {
            ...message,
            content: await mapBlocks(message.content, map, signal),
          },
    );
  return { ...request, messages };
};

const inlineBytes = (block: AnthropicImageBlock): number =>
  block.source.type === "base64" ? (block.source.data?.length ?? 0) : 0;

/**
 * How many of the oldest images to drop, in whole groups, so the rest fit the
 * request limits. The count only moves when a thread crosses a limit again.
 */
export const imagesToOmit = (sizes: number[]): number => {
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let omitted = 0;

  while (
    omitted < sizes.length &&
    (total > REQUEST_IMAGE_BUDGET_BYTES ||
      sizes.length - omitted > REQUEST_IMAGE_LIMIT)
  ) {
    const group = sizes.slice(omitted, omitted + OMIT_GROUP_SIZE);
    total -= group.reduce((sum, size) => sum + size, 0);
    omitted += group.length;
  }
  return omitted;
};

/** Fits every inline image within the provider's per-image and request limits. */
export const fitRequestImages = async (
  request: AnthropicMessagesRequest,
  signal?: AbortSignal,
): Promise<AnthropicMessagesRequest> => {
  const sizes: number[] = [];
  const fitted = await mapImages(
    request,
    async (block) => {
      const result = await fitImageBlock(block);
      if (isImageBlock(result)) sizes.push(inlineBytes(result));
      return result;
    },
    signal,
  );
  const omit = imagesToOmit(sizes);

  if (omit === 0) return fitted;
  let seen = 0;

  return mapImages(
    fitted,
    async (block) =>
      seen++ < omit ? { type: "text", text: OMITTED_FOR_SIZE_TEXT } : block,
    signal,
  );
};

export const resetFittedImageCache = (): void => {
  cache.clear();
  inFlight.clear();
  cachedBytes = 0;
};

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import type {
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicToolResultBlock,
} from "../wire/anthropic";
import { codexToAnthropic } from "../translate/codex-to-anthropic";
import { estimateGatewayResponsesInputTokens } from "../data-plane/token-estimation";
import type { CodexResponsesRequest } from "../wire/codex-responses";
import { imageDimensions } from "./image-format";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  OMITTED_FOR_SIZE_TEXT,
  REQUEST_IMAGE_BUDGET_BYTES,
  UNREADABLE_IMAGE_TEXT,
  fitRequestImages,
  imagesToOmit,
  resetFittedImageCache,
} from "./fit-images";

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: "#e8eef7" },
  })
    .png()
    .toBuffer();

// Random pixels do not compress, so the fitted PNG stays over the byte limit.
const noisePng = (width: number, height: number): Promise<Buffer> =>
  sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();

const image = (data: Buffer, mediaType = "image/png"): AnthropicImageBlock => ({
  type: "image",
  source: {
    type: "base64",
    media_type: mediaType,
    data: data.toString("base64"),
  },
});

// The shape Codex view_image output takes after translation.
const toolResultRequest = (
  ...blocks: AnthropicImageBlock[]
): AnthropicMessagesRequest => ({
  model: "claude-opus-5-5",
  max_tokens: 1_024,
  messages: [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "view_image", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: blocks },
      ],
    },
  ],
});

const resultBlocks = (request: AnthropicMessagesRequest) => {
  const content = request.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const result = content[0] as AnthropicToolResultBlock;
  assert.ok(Array.isArray(result.content));
  return result.content;
};

const sizeOf = (block: unknown) => {
  const source = (block as AnthropicImageBlock).source;
  return imageDimensions(Buffer.from(source.data!, "base64"));
};

test("retina screenshots in tool results are fitted within 2000 px", async () => {
  resetFittedImageCache();
  const request = toolResultRequest(image(await png(2_880, 7_836)));
  const [fitted] = resultBlocks(await fitRequestImages(request));

  assert.equal(fitted?.type, "image");
  assert.equal((fitted as AnthropicImageBlock).source.media_type, "image/webp");
  const size = sizeOf(fitted);
  assert.ok(size);
  assert.equal(size.height, MAX_IMAGE_EDGE);
  // Aspect ratio survives: 2880 x 7836 scaled to a 2000 px long edge.
  assert.equal(size.width, 735);
  // The original request is not modified.
  assert.equal(sizeOf(resultBlocks(request)[0])?.height, 7_836);
});

test("fitting is deterministic so the prompt cache stays warm", async () => {
  const source = await png(3_000, 2_000);
  resetFittedImageCache();
  const first = resultBlocks(
    await fitRequestImages(toolResultRequest(image(source))),
  );
  resetFittedImageCache();
  const second = resultBlocks(
    await fitRequestImages(toolResultRequest(image(source))),
  );

  assert.deepEqual(first, second);
});

test("images already within limits pass through untouched", async () => {
  const small = image(await png(1_440, 900));
  const [fitted] = resultBlocks(
    await fitRequestImages(toolResultRequest(small)),
  );

  assert.equal(fitted, small);
});

test("a mislabelled image gets the type its bytes encode", async () => {
  const bytes = await png(400, 300);
  const [fitted] = resultBlocks(
    await fitRequestImages(
      toolResultRequest(image(bytes, "application/octet-stream")),
    ),
  );

  assert.deepEqual((fitted as AnthropicImageBlock).source, {
    type: "base64",
    media_type: "image/png",
    data: bytes.toString("base64"),
  });
});

test("bytes that are not an image become an explicit text note", async () => {
  const [fitted] = resultBlocks(
    await fitRequestImages(
      toolResultRequest(image(Buffer.from("not an image"))),
    ),
  );

  assert.deepEqual(fitted, { type: "text", text: UNREADABLE_IMAGE_TEXT });
});

test("a fitted image that is still too heavy drops to a lower quality", async () => {
  resetFittedImageCache();
  const [fitted] = resultBlocks(
    await fitRequestImages(
      toolResultRequest(image(await noisePng(2_400, 2_400))),
    ),
  );
  const source = (fitted as AnthropicImageBlock).source;

  assert.equal(source.media_type, "image/webp");
  assert.ok(Buffer.from(source.data!, "base64").length <= MAX_IMAGE_BYTES);
});

test("Codex data URLs with a generic media type still reach the provider", async () => {
  const bytes = await png(200, 100);
  const converted = codexToAnthropic(
    {
      model: "anthropic/claude-opus-5-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
            },
          ],
        },
      ],
      instructions: "",
      tool_choice: "auto",
      parallel_tool_calls: false,
      include: [],
      stream: true,
      store: false,
    },
    { model: "claude-opus-5-5", maxOutputTokens: 1_024 },
  );
  const fitted = await fitRequestImages(converted.request);
  const content = fitted.messages[0]!.content;

  assert.ok(Array.isArray(content));
  assert.equal(
    (content[0] as AnthropicImageBlock).source.media_type,
    "image/png",
  );
});

test("heavy images that already fit are re-encoded compactly", async () => {
  resetFittedImageCache();
  const heavy = await noisePng(700, 500);
  assert.ok(heavy.length > 256 * 1024);
  const [fitted] = resultBlocks(
    await fitRequestImages(toolResultRequest(image(heavy))),
  );
  const source = (fitted as AnthropicImageBlock).source;

  assert.equal(source.media_type, "image/webp");
  assert.deepEqual(sizeOf(fitted), { width: 700, height: 500 });
});

test("oldest images are dropped in whole groups past the request limits", async () => {
  const small = 1_000;
  // Under both limits: nothing is dropped.
  assert.equal(imagesToOmit(Array(100).fill(small)), 0);
  // Over the 100-image limit: the oldest group of 20 goes, and the count stays
  // put while the thread grows, so the history prefix remains stable.
  assert.equal(imagesToOmit(Array(101).fill(small)), 20);
  assert.equal(imagesToOmit(Array(120).fill(small)), 20);
  assert.equal(imagesToOmit(Array(121).fill(small)), 40);
  // Over the byte budget.
  const heavy = Math.floor(REQUEST_IMAGE_BUDGET_BYTES / 30);
  assert.equal(imagesToOmit(Array(30).fill(heavy)), 0);
  assert.equal(imagesToOmit(Array(31).fill(heavy)), 20);
});

test("dropped images leave a note in place of the oldest ones", async () => {
  const tiny = image(await png(8, 8));
  const request: AnthropicMessagesRequest = {
    model: "claude-opus-5-5",
    max_tokens: 1_024,
    messages: [{ role: "user", content: Array(101).fill(tiny) }],
  };
  const content = (await fitRequestImages(request)).messages[0]!.content;

  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: OMITTED_FOR_SIZE_TEXT });
  assert.deepEqual(content[19], { type: "text", text: OMITTED_FOR_SIZE_TEXT });
  assert.equal(content[20], tiny);
  assert.equal(content.filter((block) => block.type === "image").length, 81);
});

test("fitting stops when the request is aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fitRequestImages(
      toolResultRequest(image(await png(3_000, 3_000))),
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("concurrent requests for one screenshot share a single result", async () => {
  resetFittedImageCache();
  const shot = image(await png(3_200, 1_800));
  const [a, b] = await Promise.all([
    fitRequestImages(toolResultRequest(shot)),
    fitRequestImages(toolResultRequest(shot)),
  ]);

  assert.deepEqual(resultBlocks(a), resultBlocks(b));
});

test("generically labelled images are costed from their real size", async () => {
  const bytes = await png(400, 300);
  const request = {
    model: "anthropic/claude-opus-5-5",
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
          },
        ],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    include: [],
    stream: true,
    store: false,
  } satisfies CodexResponsesRequest;

  // The unknown-image fallback charges 10,000 tokens; a 400x300 image is far less.
  assert.ok(estimateGatewayResponsesInputTokens(request).approximate < 1_000);
});

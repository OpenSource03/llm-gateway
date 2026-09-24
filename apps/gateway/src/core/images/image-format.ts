// Header-only image inspection: format and pixel size without decoding.

export interface ImageDimensions {
  width: number;
  height: number;
}

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

export const imageDimensions = (data: Buffer): ImageDimensions | null => {
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

export type ImageMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The media type the bytes actually encode, or null for anything else. */
export const sniffImageMediaType = (data: Buffer): ImageMediaType | null => {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47)
    return "image/png";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  if (
    data.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))
  )
    return "image/gif";
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";

  return null;
};

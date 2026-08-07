// RGBA8 to PNG, using only node:zlib.
//
// Studio hands back tightly packed RGBA pixels; this turns them into a file.
// Written out rather than pulled from npm because the format's compressed
// section is exactly what zlib already does, and the rest is four chunks and a
// CRC — a dependency here would be larger than the code it replaced.
//
// Spec: https://www.w3.org/TR/png/

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG's CRC-32 is the standard one; the table is built once.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }

  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

export class PngError extends Error {}

/**
 * Encodes tightly packed RGBA8 into a PNG.
 *
 * Every scanline gets filter type 0 (None). Adaptive filtering would compress
 * better, but these images are screenshots headed straight to disk, and a
 * wrong filter is a corrupt file rather than a slightly larger one.
 */
export function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PngError(`invalid dimensions: ${width}x${height}`);
  }

  const expected = width * height * 4;

  if (rgba.length !== expected) {
    // The single most likely failure: a truncated transfer, or dimensions that
    // do not describe the bytes. Catching it here beats writing a broken file.
    throw new PngError(`expected ${expected} bytes for ${width}x${height}, got ${rgba.length}`);
  }

  // Each scanline is prefixed with its filter byte.
  const raw = Buffer.alloc(height * (width * 4 + 1));

  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4;
    const to = y * (width * 4 + 1);

    raw[to] = 0;
    rgba.copy(raw, to + 1, from, from + width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type 6 = truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Reads back width, height and colour type. Used to verify what we wrote. */
export function readPngHeader(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError("not a PNG");
  }

  if (png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new PngError("first chunk is not IHDR");
  }

  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colourType: png[25],
  };
}

/**
 * Crops tightly packed RGBA in place-ish, returning a new buffer.
 *
 * Used for region captures: Studio hands back the whole viewport and the
 * caller usually wants one rectangle out of it.
 */
export function cropRgba(rgba, width, height, { x, y, width: w, height: h }) {
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
    throw new PngError(`crop ${w}x${h} at ${x},${y} does not fit inside ${width}x${height}`);
  }

  const out = Buffer.alloc(w * h * 4);

  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * width + x) * 4;
    rgba.copy(out, row * w * 4, from, from + w * 4);
  }

  return out;
}

/**
 * The bounding box of everything with alpha above `threshold`.
 *
 * This is what makes an isolated capture tight: render the subject on a
 * transparent background, then trim to the pixels that actually got drawn.
 * Returns null when the image is entirely transparent, which the caller must
 * treat as "nothing rendered" rather than cropping to nothing.
 */
export function alphaBounds(rgba, width, height, threshold = 0) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

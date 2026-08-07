import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { encodePng, readPngHeader, cropRgba, alphaBounds, PngError } from "./png.js";

/** Builds RGBA where each pixel encodes its own coordinates, so crops are checkable. */
function grid(width, height) {
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at] = x;
      rgba[at + 1] = y;
      rgba[at + 2] = 0;
      rgba[at + 3] = 255;
    }
  }

  return rgba;
}

// -------------------------------------------------------------- encoding

test("writes a PNG with a correct signature and header", () => {
  const png = encodePng(grid(4, 3), 4, 3);

  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.deepEqual(readPngHeader(png), { width: 4, height: 3, bitDepth: 8, colourType: 6 });
});

test("ends with IEND", () => {
  const png = encodePng(grid(2, 2), 2, 2);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

test("the pixel data round-trips through the deflate stream", () => {
  // Decoding the IDAT proves the scanline filter bytes and row layout are
  // right — a header alone would pass even if the body were nonsense.
  const width = 5;
  const height = 4;
  const rgba = grid(width, height);
  const png = encodePng(rgba, width, height);

  const start = 8 + 25; // signature + IHDR chunk
  const idatLength = png.readUInt32BE(start);
  assert.equal(png.subarray(start + 4, start + 8).toString("ascii"), "IDAT");

  const raw = inflateSync(png.subarray(start + 8, start + 8 + idatLength));

  assert.equal(raw.length, height * (width * 4 + 1));

  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 4 + 1);
    assert.equal(raw[at], 0, `scanline ${y} must use filter 0`);
    assert.deepEqual(raw.subarray(at + 1, at + 1 + width * 4), rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
});

test("a wrong byte count is refused rather than written", () => {
  // A truncated transfer is the likeliest real failure; a file written from it
  // would look fine until something tried to open it.
  assert.throws(() => encodePng(Buffer.alloc(10), 4, 3), /expected 48 bytes for 4x3, got 10/);
  assert.throws(() => encodePng(Buffer.alloc(49), 4, 3), /expected 48 bytes/);
});

test("invalid dimensions are refused", () => {
  for (const [w, h] of [[0, 1], [1, 0], [-1, 1], [1.5, 2]]) {
    assert.throws(() => encodePng(Buffer.alloc(0), w, h), PngError);
  }
});

test("a single pixel encodes", () => {
  const png = encodePng(Buffer.from([1, 2, 3, 4]), 1, 1);
  assert.deepEqual(readPngHeader(png), { width: 1, height: 1, bitDepth: 8, colourType: 6 });
});

test("readPngHeader rejects things that are not PNGs", () => {
  assert.throws(() => readPngHeader(Buffer.alloc(4)), /not a PNG/);
  assert.throws(() => readPngHeader(Buffer.alloc(40)), /not a PNG/);
});

// ---------------------------------------------------------------- crop

test("crops the requested rectangle", () => {
  const rgba = grid(8, 6);
  const out = cropRgba(rgba, 8, 6, { x: 2, y: 1, width: 3, height: 2 });

  assert.equal(out.length, 3 * 2 * 4);
  // Each pixel carries its original coordinates, so the offset is verifiable.
  assert.equal(out[0], 2, "top-left of the crop should be source x=2");
  assert.equal(out[1], 1, "…and source y=1");
  assert.equal(out[out.length - 4], 4, "bottom-right should be source x=4");
  assert.equal(out[out.length - 3], 2, "…and source y=2");
});

test("a full-size crop returns the original pixels", () => {
  const rgba = grid(4, 4);
  assert.deepEqual(cropRgba(rgba, 4, 4, { x: 0, y: 0, width: 4, height: 4 }), rgba);
});

test("a crop that does not fit is refused", () => {
  const rgba = grid(4, 4);
  for (const box of [
    { x: -1, y: 0, width: 2, height: 2 },
    { x: 3, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 3, width: 4, height: 2 },
  ]) {
    assert.throws(() => cropRgba(rgba, 4, 4, box), /does not fit/);
  }
});

// --------------------------------------------------------- alpha bounds

test("finds the bounding box of the drawn pixels", () => {
  // The whole point of a tight crop: trim a transparent canvas to its subject.
  const width = 10;
  const height = 8;
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 2; y <= 5; y += 1) {
    for (let x = 3; x <= 7; x += 1) {
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }

  assert.deepEqual(alphaBounds(rgba, width, height), { x: 3, y: 2, width: 5, height: 4 });
});

test("a fully transparent image has no bounds, rather than an empty crop", () => {
  // Returning a zero-size box would make the caller crop to nothing and write
  // an invalid file; null forces it to decide what "nothing rendered" means.
  assert.equal(alphaBounds(Buffer.alloc(4 * 4 * 4), 4, 4), null);
});

test("a fully opaque image bounds to the whole thing", () => {
  assert.deepEqual(alphaBounds(grid(6, 5), 6, 5), { x: 0, y: 0, width: 6, height: 5 });
});

test("the threshold ignores near-transparent edge pixels", () => {
  // Anti-aliased edges leave a halo of alpha 1-3; cropping to those makes the
  // subject look off-centre.
  const width = 5;
  const height = 5;
  const rgba = Buffer.alloc(width * height * 4);

  rgba[(0 * width + 0) * 4 + 3] = 2; // faint halo
  rgba[(2 * width + 2) * 4 + 3] = 255; // the subject

  assert.deepEqual(alphaBounds(rgba, width, height, 0), { x: 0, y: 0, width: 3, height: 3 });
  assert.deepEqual(alphaBounds(rgba, width, height, 8), { x: 2, y: 2, width: 1, height: 1 });
});

// ------------------------------------------------------------ end to end

test("crop then encode produces a valid PNG of the cropped size", () => {
  const rgba = grid(16, 12);
  const box = { x: 4, y: 3, width: 6, height: 5 };
  const png = encodePng(cropRgba(rgba, 16, 12, box), box.width, box.height);

  assert.deepEqual(readPngHeader(png), { width: 6, height: 5, bitDepth: 8, colourType: 6 });
});

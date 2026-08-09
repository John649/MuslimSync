// assets/Logo.png -> a Windows .ico.
//
// Windows reads a window's taskbar icon and a shortcut's icon out of an .ico.
// The mac side of this repo gets its .icns from sips and iconutil; neither
// exists here, and assuming ImageMagick is installed is not a plan. So this
// does the whole job in Node: decode the 512px logo, box-filter it down, and
// write the container by hand. An .ico is a directory of images with a 6-byte
// header, which is less code than taking on a dependency for it.
//
// Used by make-shortcut.mjs, which generates the file on demand the way
// make-app.mjs builds the mac bundle on demand.

import { inflateSync } from "node:zlib";

import { encodePng } from "../daemon/png.js";

// The sizes Windows actually asks for: list views and the taskbar want the
// small three, Explorer's large tiles and the alt-tab overlay want 256.
export const SIZES = [16, 32, 48, 256];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes an 8-bit truecolour PNG into tightly packed RGBA.
 *
 * Deliberately narrow: this reads what daemon/png.js writes and what an
 * exported logo normally is. Anything else throws rather than guessing, because
 * a wrong guess here is a corrupt icon that Windows silently ignores.
 */
export function decodePng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png[24];
  const colour = png[25];
  const interlace = png[28];

  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}, interlace ${interlace}`);
  }

  // IDAT may be split across chunks; the compressed stream spans all of them.
  const parts = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("ascii");
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
    if (type === "IEND") break;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const from = y * (stride + 1);
    const filter = raw[from];
    raw.copy(line, 0, from + 1, from + 1 + stride);

    // Each scanline is stored as a delta against its left and upper neighbours.
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const corner = i >= channels ? previous[i - channels] : 0;

      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) line[i] = (line[i] + paeth(left, up, corner)) & 0xff;
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`);
    }

    for (let x = 0; x < width; x += 1) {
      const at = x * channels;
      const to = (y * width + x) * 4;
      rgba[to] = line[at];
      rgba[to + 1] = line[at + 1];
      rgba[to + 2] = line[at + 2];
      rgba[to + 3] = channels === 4 ? line[at + 3] : 255;
    }

    line.copy(previous);
  }

  return { width, height, rgba };
}

/** Box-filters RGBA down to size x size, averaging in premultiplied alpha. */
export function resizeRgba(rgba, width, height, size) {
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const top = Math.floor((y * height) / size);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / size));

    for (let x = 0; x < size; x += 1) {
      const left = Math.floor((x * width) / size);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / size));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const at = (sy * width + sx) * 4;
          // Weighted by alpha, or a transparent pixel drags its colour into the
          // edge and the logo comes out with a halo at 16px.
          const alpha = rgba[at + 3] / 255;
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += rgba[at + 3];
          count += 1;
        }
      }

      const to = (y * size + x) * 4;
      out[to + 3] = Math.round(a / count);

      const alpha = out[to + 3] / 255;
      out[to] = alpha ? Math.min(255, Math.round(r / count / alpha)) : 0;
      out[to + 1] = alpha ? Math.min(255, Math.round(g / count / alpha)) : 0;
      out[to + 2] = alpha ? Math.min(255, Math.round(b / count / alpha)) : 0;
    }
  }

  return out;
}

/**
 * One image as a 32bpp bottom-up DIB.
 *
 * The height is doubled because the format still expects a 1-bit transparency
 * mask after the colour rows. With 32bpp Windows uses the alpha channel and
 * ignores the mask, so it is left as zeroes — but it has to be there.
 */
function dib(rgba, size) {
  const maskStride = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + size * maskStride);

  out.writeUInt32LE(40, 0); // BITMAPINFOHEADER size
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bits per pixel
  out.writeUInt32LE(size * size * 4, 20);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = 40 + (y * size + x) * 4;
      out[to] = rgba[from + 2];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from];
      out[to + 3] = rgba[from + 3];
    }
  }

  return out;
}

/** Wraps already-encoded images in an icon directory. */
export function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;

  images.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    // Width and height are single bytes, so 256 is written as 0.
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); // planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

/** Renders a source PNG into a multi-size .ico. */
export function buildIco(logo) {
  const { width, height, rgba } = decodePng(logo);

  return encodeIco(
    SIZES.map((size) => {
      const scaled = resizeRgba(rgba, width, height, size);

      // 256 goes in as PNG: as a raw DIB it is a quarter of a megabyte, and PNG
      // entries are what Windows expects at that size anyway.
      return { size, data: size >= 256 ? encodePng(scaled, size, size) : dib(scaled, size) };
    }),
  );
}

/** Reads the directory back, so a caller can check what it just wrote. */
export function readIcoEntries(ico) {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error("not an .ico");
  }

  const entries = [];

  for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
    const at = 6 + index * 16;
    const offset = ico.readUInt32LE(at + 12);

    entries.push({
      width: ico[at] || 256,
      height: ico[at + 1] || 256,
      bits: ico.readUInt16LE(at + 6),
      bytes: ico.readUInt32LE(at + 8),
      encoding: ico[offset] === 0x89 ? "png" : "bmp",
    });
  }

  return entries;
}

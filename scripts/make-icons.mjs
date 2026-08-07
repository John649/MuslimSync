// Generates the plugin's toolbar icons.
//
// The fork inherited Argon's uploaded artwork, which is not ours to ship under
// this name. These are drawn from scratch instead: a rounded square with a
// crescent, tinted per connection state.
//
// Roblox toolbar icons must be uploaded — a plugin cannot reference a local
// file — so this writes PNGs for you to upload once. See assets/README.md.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng } from "../daemon/png.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;

const STATES = {
  Logo: "#3ba55d",
  LogoOk: "#43b581",
  LogoWarn: "#f0b232",
  LogoError: "#da373c",
};

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** Signed distance to a rounded square, so the edge can be antialiased. */
function roundedSquare(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * A crescent: one disc with a second, offset disc subtracted.
 *
 * Returns coverage 0..1 rather than a boolean so the curve does not come out
 * jagged at 32 pixels, which is roughly where Studio draws it.
 */
function crescent(x, y, size) {
  const outer = { x: size * 0.46, y: size * 0.5, r: size * 0.28 };
  const inner = { x: size * 0.56, y: size * 0.46, r: size * 0.24 };

  const edge = size * 0.012;
  const inOuter = 1 - smoothstep(outer.r - edge, outer.r + edge, Math.hypot(x - outer.x, y - outer.y));
  const inInner = 1 - smoothstep(inner.r - edge, inner.r + edge, Math.hypot(x - inner.x, y - inner.y));

  return Math.max(0, inOuter - inInner);
}

function smoothstep(from, to, value) {
  const t = Math.min(Math.max((value - from) / (to - from), 0), 1);
  return t * t * (3 - 2 * t);
}

function icon(hex) {
  const [r, g, b] = rgb(hex);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const edge = SIZE * 0.01;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const at = (y * SIZE + x) * 4;

      // Background plate, antialiased at its rounded corners.
      const plate = 1 - smoothstep(-edge, edge, roundedSquare(x + 0.5, y + 0.5, SIZE, SIZE * 0.22));
      const moon = crescent(x + 0.5, y + 0.5, SIZE) * plate;

      // The crescent is white over the plate; compositing rather than
      // overwriting keeps its edge smooth against the tint.
      rgba[at] = Math.round(r * (1 - moon) + 255 * moon);
      rgba[at + 1] = Math.round(g * (1 - moon) + 255 * moon);
      rgba[at + 2] = Math.round(b * (1 - moon) + 255 * moon);
      rgba[at + 3] = Math.round(plate * 255);
    }
  }

  return encodePng(rgba, SIZE, SIZE);
}

const out = path.join(ROOT, "assets");
mkdirSync(out, { recursive: true });

for (const [name, hex] of Object.entries(STATES)) {
  const file = path.join(out, `${name}.png`);
  writeFileSync(file, icon(hex));
  console.log(`wrote ${path.relative(ROOT, file)}  ${hex}`);
}

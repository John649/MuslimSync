// Path safety for everything the Studio plugin can reach.
//
// The plugin is a remote caller: it asks for folders to be listed and created.
// It must never be able to name a path outside the user's authorized projects
// root, so every path it supplies goes through `resolveWithin` and every folder
// name through `slugify`. Both are pure and heavily tested, because a bug here
// is a directory traversal rather than a cosmetic glitch.

import path from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";

/**
 * Whether `target` is `root` itself or lives beneath it.
 *
 * Compares resolved paths and requires a separator boundary, so `/a/projects`
 * does not contain `/a/projects-evil` — a plain `startsWith` says it does.
 */
export function isWithin(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);

  if (from === to) return true;

  const relative = path.relative(from, to);

  // A path outside `root` produces a relative path that climbs out of it, and
  // a different drive on Windows produces an absolute one.
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Expands a leading `~` to the home directory.
 *
 * The plugin's directory field displays paths shortened for readability
 * (/Users/someone -> ~) and sends that same string back. Without this, `~`
 * became a literal folder name and a project landed in
 * <root>/~/projects/<root>/<name>. A `~` anywhere but the start is a legal
 * filename character and stays literal.
 */
export function expandHome(candidate) {
  const value = String(candidate ?? "");

  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

/**
 * Resolves `candidate` and asserts it stays inside `root`, following symlinks
 * as far as they exist.
 *
 * Checking the lexical path alone is not enough: a symlink inside the root can
 * point anywhere, and `path.resolve` will not notice. Where a path does not
 * exist yet (a folder about to be created) the nearest existing ancestor is
 * resolved instead, which is the part an attacker could have replaced.
 */
export function resolveWithin(root, candidate) {
  const realRoot = realpathSync(path.resolve(root));
  const resolved = path.resolve(realRoot, expandHome(candidate));

  if (!isWithin(realRoot, resolved)) {
    throw new PathEscape(`${resolved} is outside ${realRoot}`);
  }

  // Walk up to the closest ancestor that exists, resolve its real location,
  // then re-append the part that does not exist yet.
  let existing = resolved;
  const missing = [];

  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) throw new PathEscape(`cannot resolve ${resolved}`);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const real = path.join(existing, ...missing);

  if (!isWithin(realRoot, real)) {
    throw new PathEscape(`${candidate} escapes ${realRoot} through a link`);
  }

  return real;
}

export class PathEscape extends Error {
  constructor(message) {
    super(message);
    this.name = "PathEscape";
    this.code = "PROJECT_PATH_ESCAPE";
  }
}

const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Turns a Roblox place name into a portable folder name.
 *
 * Rejects rather than mangles when nothing usable survives: silently creating
 * a folder called "untitled" for a name the user typed is worse than saying so.
 */
export function slugify(name) {
  const cleaned = String(name ?? "")
    // NFC, not NFKD. Decomposing splits a character into a base plus a
    // combining mark, and the mark is not a letter — so NFKD turned ゲーム into
    // ケ-ーム, and would do the same to Arabic harakat.
    .normalize("NFC")
    // Anything that is not a letter, number, combining mark, space, dash or
    // underscore becomes a dash. That covers path separators, colons, and
    // every shell metacharacter. \p{M} keeps scripts whose vowels and
    // diacritics are separate code points even after composition.
    .replace(/[^\p{L}\p{N}\p{M} _-]+/gu, "-")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    // Trimming to 64 can leave a trailing dash behind.
    .replace(/-+$/, "");

  if (!cleaned) throw new InvalidName(`"${name}" contains no usable characters for a folder name`);

  // Windows refuses these as filenames regardless of extension, and a project
  // created on macOS should still open on Windows.
  if (RESERVED.has(cleaned.toLowerCase())) {
    throw new InvalidName(`"${cleaned}" is a reserved filename on Windows`);
  }

  return cleaned;
}

export class InvalidName extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidName";
    this.code = "INVALID_NAME";
  }
}

/**
 * Picks a folder name that does not collide, using a caller-supplied
 * existence test.
 *
 * The first fallback is the game id rather than "-2", so a re-created project
 * for the same universe lands on the same predictable name instead of drifting
 * upward every attempt.
 */
export function uniqueName(base, exists, { gameId } = {}) {
  if (!exists(base)) return base;

  if (gameId) {
    const withId = `${base}-${gameId}`;
    if (!exists(withId)) return withId;
  }

  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }

  throw new InvalidName(`could not find a free folder name for "${base}"`);
}

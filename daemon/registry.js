// The record of projects the root's scan cannot reach.
//
// projects.list() discovers projects by reading the direct children of the
// projects root, and that stays the primary mechanism: a project cloned from git
// or made by hand appears in the list without anyone registering it. But the
// scan is one level deep, and the create dialog accepts a subfolder — so a
// project created in <root>/Scratch/game served and synced perfectly while never
// appearing in the list again. Worse, after a restart identity matching reads
// that same list, so reconnecting the place would not find its project and would
// scaffold a duplicate beside it.
//
// This file holds the absolute paths of those projects and nothing else. Keeping
// it to what the scan misses is what keeps it small enough that a stale entry is
// cheap to notice and cheap to drop.
//
// The file to use is passed in rather than derived here, the same way
// socket.js and artifacts.js take their locations: the app owns ~/.muslimsync,
// and the headless daemon has no state directory at all.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { pathKey, resolveWithin } from "./paths.js";

/**
 * The registered paths.
 *
 * Missing, unparseable, or holding something that is not a list of strings all
 * read as empty. A record of projects is worth losing to a corrupt file; the
 * daemon that serves them is not.
 */
export function read(file) {
  if (!file) return [];

  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(stored)) return [];

    return stored.filter((entry) => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * The form of a path worth storing.
 *
 * Symlinks resolved, because the scan a stored path is compared against resolves
 * them too — on macOS a temp or home path routinely arrives as /var and comes
 * back as /private/var, and the two spellings would list one project twice.
 */
function canonical(candidate) {
  const resolved = path.resolve(candidate);

  try {
    return realpathSync(resolved);
  } catch {
    // Not there yet, or not readable. Storing the lexical path is still better
    // than refusing to remember the project at all.
    return resolved;
  }
}

function write(file, paths) {
  mkdirSync(path.dirname(file), { recursive: true });

  // Write-then-rename, as settings.json does: a crash mid-write must not leave
  // a truncated file, because the next read would treat that as "no projects"
  // and silently forget every one of them.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(paths, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * Remembers a project, if remembering it would tell us anything.
 *
 * A direct child of the root is already found by scanning, so recording it would
 * be a second source of truth for a project that has one. Registering a path
 * twice is a no-op, so the callers can be the moments a path becomes known —
 * creating and serving — without checking first whether it already is.
 *
 * Returns whether the file was written, which is what the tests assert on.
 */
export function register(file, root, projectPath) {
  if (!file) return false;

  const target = canonical(projectPath);

  // realpathSync through resolveWithin, so a root the user typed in a different
  // case, or reached through a symlink, still recognises its own children.
  let realRoot = null;
  try {
    realRoot = resolveWithin(root, "");
  } catch {
    // A root that does not exist cannot be the parent of anything, which makes
    // this path worth remembering rather than a reason to refuse.
  }

  if (realRoot && pathKey(path.dirname(target)) === pathKey(realRoot)) return false;

  const stored = read(file);
  if (stored.some((entry) => pathKey(entry) === pathKey(target))) return false;

  write(file, [...stored, target]);
  return true;
}

/**
 * Drops paths from the record.
 *
 * Called with the entries that are no longer projects, so a folder someone
 * deleted or moved cannot accumulate here forever.
 */
export function forget(file, paths) {
  if (!file || paths.length === 0) return;

  const dropped = new Set(paths.map(pathKey));
  write(
    file,
    read(file).filter((entry) => !dropped.has(pathKey(entry))),
  );
}

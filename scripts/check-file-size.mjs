// Enforces the 400-line cap.
//
// This gate exists because of what unbounded files did to the codebase we ported
// ideas from: one 12,252-line Plugin.luau, a 7,892-line request handler. Nobody
// decided to write those; they accreted because nothing said stop.
//
// GRANDFATHERED lists files inherited from the Argon fork that were already over
// the line when MuslimSync started. The list may shrink, never grow: adding an
// entry is not an option, splitting the file is.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT = 400;

const ROOTS = ["plugin/src", "daemon", "cli", "app", "quran", "commands", "scripts"];
const SKIP = new Set(["node_modules", "Packages", "Lib", "dist", "target", ".git"]);
const EXTENSIONS = new Set([".luau", ".lua", ".js", ".mjs"]);

const GRANDFATHERED = new Map([
  ["plugin/src/App/init.luau", 807],
  ["plugin/src/App/Widgets/Diff.luau", 421],
  ["plugin/src/Core/init.luau", 468],
  ["plugin/src/App/Widgets/Settings.luau", 435],
  ["plugin/src/Core/Processor/Write.luau", 417],
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry))) {
      yield full;
    }
  }
}

/** Lines of content, matching `wc -l`: a trailing newline does not add a line. */
function countLines(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

const failures = [];
const shrunk = [];

for (const root of ROOTS) {
  for (const file of walk(path.join(ROOT, root))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = countLines(readFileSync(file, "utf8"));
    const allowance = GRANDFATHERED.get(rel);

    if (allowance === undefined) {
      if (lines > LIMIT) failures.push(`${rel}: ${lines} lines (limit ${LIMIT})`);
      continue;
    }

    // A grandfathered file may not grow past the size it was inherited at.
    if (lines > allowance) {
      failures.push(`${rel}: ${lines} lines, grandfathered at ${allowance} — it grew`);
    } else if (lines <= LIMIT) {
      shrunk.push(`${rel} is now ${lines} lines — remove it from GRANDFATHERED`);
    }
  }
}

for (const note of shrunk) console.log(`note: ${note}`);

if (failures.length) {
  console.error(`\n${failures.length} file(s) over the line cap:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`file size: OK (limit ${LIMIT}, ${GRANDFATHERED.size} grandfathered)`);

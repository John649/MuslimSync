// Putting the brief into a project, as the files agents actually read.
//
// Two files, one copy of the brief: AGENTS.md carries it, and CLAUDE.md imports
// it. Claude Code reads CLAUDE.md and never AGENTS.md, so a project with only
// the latter hands the brief to every agent except that one — and duplicating
// the text into a second file would go stale the first time either is updated.
//
// Both the CLI's `agents --install` and the app's project creation come through
// here, so a project made either way tells both kinds of agent the same thing.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { mergeInto, BEGIN, END } from "./agents.js";

// Claude Code treats a line that is just this as an instruction to read that
// file, which is all the bridge needs to be.
const IMPORT = "@AGENTS.md";

const CLAUDE_MD = `<!-- Claude Code reads this file, not AGENTS.md. The import below pulls that
file in, so the brief stays in one place. -->

${IMPORT}
`;

/**
 * The project's CLAUDE.md, reaching AGENTS.md.
 *
 * An import already anywhere in the file is left exactly as it is, whatever the
 * user has built around it: the file already does the one thing we need of it,
 * and their arrangement of it is not ours to tidy.
 */
export function mergeClaudeMd(existing) {
  if (!existing || !existing.trim()) return CLAUDE_MD;
  if (existing.includes(IMPORT)) return existing;

  // Marked like the AGENTS.md section, for the same reason: a later install has
  // to recognise its own work, and the project has to be able to see which line
  // is not theirs.
  return `${existing.trimEnd()}\n\n${[BEGIN, "", IMPORT, "", END, ""].join("\n")}`;
}

/** A file's text, or "" when it is not there yet — the common case, not an error. */
function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Adds or refreshes the brief in `dir`, reporting what it did to each file.
 *
 * A file that would not change is not rewritten, so re-installing is a no-op
 * down to the mtime rather than merely down to the bytes.
 */
export function installBrief(dir, options) {
  const files = [
    { file: path.join(dir, "AGENTS.md"), merge: (before) => mergeInto(before, options) },
    { file: path.join(dir, "CLAUDE.md"), merge: mergeClaudeMd },
  ];

  return files.map(({ file, merge }) => {
    const before = read(file);
    const after = merge(before);

    if (after !== before) writeFileSync(file, after);

    return { path: file, changed: after !== before, created: !before };
  });
}

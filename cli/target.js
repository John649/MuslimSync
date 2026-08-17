// Which place a command runs in, and whether `source` should go to Studio.
//
// Both questions are asked before every command and neither belongs in the
// dispatcher: one is about the working directory, the other about the project's
// tree, and msync.js only needs the answer.

import path from "node:path";
import { MUTATING } from "./commands.js";
import { findProjectFile, projectIdentity, inferPlace, mappedToDisk } from "./place.js";

const health = (port, send) =>
  send({ port, route: "/health" })
    .then((response) => JSON.parse(response.body.toString("utf8")))
    .catch(() => null);

/** The connected place an identifier names — a ref or a placeId. Null for neither. */
const byIdentifier = (open, wanted) =>
  wanted ? (open.find((p) => String(p.ref) === String(wanted) || String(p.placeId) === String(wanted)) ?? null) : null;

/**
 * Refuses to read a script through Studio when the same script is a file.
 *
 * Only when that path is actually on disk. A project maps the services it
 * lists and no others, so ServerStorage and friends have no file behind them
 * and Studio is the only way to read them — refusing there sent an agent
 * reaching for --force to do the correct thing.
 *
 * Resolved from the *target place's* project, not the caller's directory.
 * Whether a path is on disk is a fact about the place being read; keying it
 * off cwd meant an agent running from its own workspace read synced code
 * through Studio without ever seeing the refusal.
 */
function guardSource({ state, open, inferred, positionals, flags, Fatal, EXIT }) {
  if (flags.force === true) return;
  if (!state?.serving?.length) return;

  // Which connected place this read is aimed at — resolved in the same order
  // as resolveTarget below. Checking the daemon's default before the working
  // directory made the guard reason about one place while the read hit another.
  const plugin =
    byIdentifier(open, flags.place) ??
    inferred ??
    byIdentifier(open, state.target) ??
    (open.length === 1 ? open[0] : null);

  // The served project that claims that place. Each serving path holds its own
  // project file, so identity comes from the file, not from a name.
  let file = null;
  for (const served of state.serving) {
    const candidate = findProjectFile(served);
    const identity = projectIdentity(candidate);
    if (!identity) continue;

    const owns =
      plugin &&
      (identity.placeIds.includes(String(plugin.placeId)) ||
        (identity.argonId && identity.argonId === plugin.argonId) ||
        // A universe holds many places and each is its own project, so a
        // gameId only identifies a project that has not claimed a place yet —
        // the same rule the daemon matches sessions with (daemon/projects.js
        // findByIdentity). Accepting it outright let the first-served project
        // of a universe answer for its sibling, and the refusal named a folder
        // the place was never synced to.
        (identity.gameId && identity.gameId === String(plugin.gameId) && identity.placeIds.length === 0));

    if (owns) {
      file = candidate;
      break;
    }
  }

  // No served project claims the target: an unsynced place, where Studio is
  // the only way. The cwd check stays as a fallback for a daemon too old to
  // report plugins.
  if (!mappedToDisk(file ?? findProjectFile(), positionals[0])) return;

  throw new Fatal(
    EXIT.usage,
    `this place is synced — read the file instead of going through Studio.\n` +
      `  synced to: ${path.dirname(file ?? state.serving[0])}\n` +
      `  --force reads it through Studio anyway, which is for unsaved drafts`,
  );
}

/**
 * The place a command should act on.
 *
 * The working directory answers it almost every time — an agent editing a
 * project means that project's place — so it is asked before anyone is made to
 * type an identifier, for a read as much as for a write. A read used to skip
 * the question entirely and take the daemon's default, on the grounds that
 * reading the wrong place was obvious. It is not: with several places
 * connected `get` and `tree` answered from whichever Studio touched last, and
 * a wrong answer looks exactly like a right one. Only a write is still refused
 * when nothing can answer, because a write cannot be un-seen.
 */
export async function resolveTarget({ command, positionals, flags, port, send, Fatal, EXIT }) {
  const state = await health(port, send);
  const open = state?.plugins ?? [];
  const inferred = inferPlace(open, projectIdentity(findProjectFile()));

  if (command === "source") guardSource({ state, open, inferred, positionals, flags, Fatal, EXIT });

  if (flags.place) return flags.place;

  if (inferred) {
    if (open.length > 1) {
      process.stderr.write(`using ${inferred.placeName ?? inferred.ref} — this directory's place\n`);
    }

    return inferred.ref;
  }

  // Nothing to go on. A read falls back to the daemon's default; a write with
  // several places open is refused rather than aimed by guesswork.
  if (!MUTATING.has(command) || open.length <= 1) return undefined;

  // Identifiers only. A name is shown to tell them apart by eye, but is not
  // something you can pass: every unpublished place is "Place1".
  const list = open.map((plugin) => {
    const ref = String(plugin.ref);
    return `  --place ${ref}${" ".repeat(Math.max(2, 22 - ref.length))}${plugin.placeName ?? "unnamed"}`;
  });

  throw new Fatal(
    EXIT.usage,
    `${open.length} places are connected, so ${command} needs --place to say which:\n${list.join("\n")}\n` +
      `\nOpening another place in Studio changes the default, so a write does not guess.`,
  );
}

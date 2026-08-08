// Which place a command runs in, and whether `source` should go to Studio.
//
// Both questions are asked before every command and neither belongs in the
// dispatcher: one is about the working directory, the other about the project's
// tree, and msync.js only needs the answer.

import { MUTATING } from "./commands.js";
import { findProjectFile, projectIdentity, inferPlace, mappedToDisk } from "./place.js";

const health = (port, send) =>
  send({ port, route: "/health" })
    .then((response) => JSON.parse(response.body.toString("utf8")))
    .catch(() => null);

/**
 * Refuses to read a script through Studio when the same script is a file.
 *
 * Only when that path is actually on disk. A project maps the services it
 * lists and no others, so ServerStorage and friends have no file behind them
 * and Studio is the only way to read them — refusing there sent an agent
 * reaching for --force to do the correct thing.
 */
async function guardSource({ positionals, flags, port, send, Fatal, EXIT }) {
  if (flags.force === true || !mappedToDisk(findProjectFile(), positionals[0])) return;

  const state = await health(port, send);
  if (!state?.serving?.length) return;

  throw new Fatal(
    EXIT.usage,
    `this place is synced — read the file instead of going through Studio.\n` +
      `  synced to: ${state.serving.join(", ")}\n` +
      `  --force reads it through Studio anyway, which is for unsaved drafts`,
  );
}

/**
 * The place a command should act on.
 *
 * The working directory answers it almost every time — an agent editing a
 * project means that project's place — so it is asked before anyone is made to
 * type an identifier. Only a write is refused when nothing can answer: reading
 * the wrong place is obvious and costs nothing.
 */
export async function resolveTarget({ command, positionals, flags, port, send, Fatal, EXIT }) {
  if (command === "source") await guardSource({ positionals, flags, port, send, Fatal, EXIT });

  if (flags.place || !MUTATING.has(command)) return flags.place;

  const state = await health(port, send);
  const open = state?.plugins ?? [];
  const inferred = inferPlace(open, projectIdentity(findProjectFile()));

  if (inferred) {
    if (open.length > 1) {
      process.stderr.write(`using ${inferred.placeName ?? inferred.ref} — this directory's place\n`);
    }

    return inferred.ref;
  }

  if (open.length <= 1) return undefined;

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

// Which place a command means, when nobody said.
//
// The working directory is the answer almost every time: an agent editing the
// zombieswithoutmap repo means the zombieswithoutmap place, and making it pass
// `--place 131665072265325` to say so is a tax on the common case that also
// trains everyone to ignore the flag.
//
// So the project file is read — it already carries `placeIds`, `gameId` and
// `argonId` — and matched against what is connected. Only when that cannot
// answer does the caller have to.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The nearest project file, walking up from `from`. Null when there is none. */
export function findProjectFile(from = process.cwd()) {
  let directory = path.resolve(from);

  for (;;) {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return null;
    }

    // `default.project.json` first, since that is what argon writes; any other
    // *.project.json is still a project and worth honouring.
    const named = entries.includes("default.project.json")
      ? "default.project.json"
      : entries.find((entry) => entry.endsWith(".project.json"));

    if (named) return path.join(directory, named);

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** The identity a project claims, as strings, for comparing against a session. */
export function projectIdentity(file) {
  if (!file || !existsSync(file)) return null;

  let project;
  try {
    project = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A project file we cannot parse tells us nothing about which place this
    // is. Falling through to "ask" is better than guessing from a broken file.
    return null;
  }

  return {
    file,
    gameId: project.gameId ? String(project.gameId) : null,
    placeIds: (project.placeIds ?? []).map(String),
    argonId: project.argonId ?? null,
  };
}

/**
 * The connected place this directory belongs to.
 *
 * Matched on identifiers only, most specific first: a placeId names one place,
 * an argonId names one unpublished place, and a gameId names a universe — which
 * can hold several places, so it only counts when exactly one of them is open.
 *
 * Returns null rather than a guess. The caller turns that into a question.
 */
export function inferPlace(plugins, identity) {
  if (!identity || !plugins?.length) return null;

  const byPlaceId = plugins.filter((plugin) => identity.placeIds.includes(String(plugin.placeId)));
  if (byPlaceId.length === 1) return byPlaceId[0];

  if (identity.argonId) {
    const byMarker = plugins.filter((plugin) => plugin.argonId && plugin.argonId === identity.argonId);
    if (byMarker.length === 1) return byMarker[0];
  }

  if (identity.gameId) {
    const byGame = plugins.filter((plugin) => String(plugin.gameId) === identity.gameId);
    // A universe holds many places. One open is unambiguous; two is not.
    if (byGame.length === 1) return byGame[0];
  }

  return null;
}

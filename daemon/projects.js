// Project discovery, browsing, and scaffolding for the Studio plugin.
//
// Replaces the `argon master` daemon the fork's plugin used to dial. Every path
// the plugin supplies is confined to the user's authorized projects root by
// paths.js — the plugin never names an absolute location we act on directly.
//
// Scaffolding shells out to the vendored `argon init` rather than
// reimplementing the project template, so a project we create is identical to
// one the user makes by hand.

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveWithin, slugify, uniqueName } from "./paths.js";

/** A directory is a project if it has any *.project.json at its top level. */
export function projectFileIn(directory) {
  try {
    const found = readdirSync(directory).find((entry) => entry.endsWith(".project.json"));
    return found ? path.join(directory, found) : null;
  } catch {
    return null;
  }
}

function readProjectFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A malformed project.json is the user's to fix. It should show up in the
    // picker as an unidentified project rather than vanish from the list.
    return null;
  }
}

/**
 * Lists directories for the plugin's folder browser.
 *
 * An empty path lists the root itself. `parent` is null at the root, which is
 * how the browser knows not to offer a "..".
 */
export function browse(root, requested) {
  const target = resolveWithin(root, requested || "");
  const realRoot = resolveWithin(root, "");

  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const full = path.join(target, entry.name);
      return { name: entry.name, path: full, isProject: Boolean(projectFileIn(full)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: target,
    parent: target === realRoot ? null : path.dirname(target),
    entries,
  };
}

/** Creates one directory inside the root. The name is slugified, never trusted. */
export function mkdir(root, parent, name) {
  const safeName = slugify(name);
  const target = resolveWithin(root, path.join(parent || "", safeName));

  // resolveWithin confines the result, but a caller could still have aimed the
  // parent at the root itself with a name that resolves to it.
  if (target === resolveWithin(root, "")) {
    throw new Error("refusing to create the projects root itself");
  }

  mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Every project under the root, whether or not it is being served.
 *
 * Discovery is by scanning rather than by a registry file, so a project the
 * user created by hand or cloned from git appears without being registered.
 */
export function list(root, { running = new Map() } = {}) {
  let realRoot;
  let directories;

  try {
    // The configured root may not exist yet — the user can name a folder
    // before creating it. That is an empty list, not an error.
    realRoot = resolveWithin(root, "");
    directories = readdirSync(realRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects = [];

  for (const entry of directories) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const directory = path.join(realRoot, entry.name);
    const file = projectFileIn(directory);
    if (!file) continue;

    const project = readProjectFile(file) ?? {};
    const session = running.get(directory);

    projects.push({
      name: project.name || entry.name,
      path: directory,
      gameId: project.gameId ?? null,
      placeIds: Array.isArray(project.placeIds) ? project.placeIds : [],
      argonId: project.argonId ?? null,
      running: Boolean(session),
      host: session?.host ?? null,
      port: session?.port ?? null,
      lastServed: session?.startedAt ?? null,
      gameConfig: project.gameConfig ?? null,
      placeConfig: project.placeConfig ?? null,
    });
  }

  // Most recently served first, then alphabetical. The picker shows this order
  // and the project you last worked on is the one you usually want.
  return projects.sort((a, b) => (b.lastServed ?? 0) - (a.lastServed ?? 0) || a.name.localeCompare(b.name));
}

/** Finds an existing project for a universe, so creating twice is idempotent. */
export function findByIdentity(projects, { gameId, placeId, argonId }) {
  if (argonId) return projects.find((project) => project.argonId === argonId) ?? null;

  if (placeId) {
    const byPlace = projects.find((project) => project.placeIds.includes(Number(placeId)));
    if (byPlace) return byPlace;
  }

  if (gameId) {
    // Only a project that has not claimed a place yet. A universe can hold many
    // places and each is its own project — matching on gameId alone meant
    // opening a second place in a universe adopted the first place's project
    // and synced two different places into one folder.
    //
    // The narrow case this still serves is real: a project created for a game
    // whose first place has not checked in, which is how create-then-claim
    // works.
    const unclaimed = projects.find(
      (project) => project.gameId === Number(gameId) && project.placeIds.length === 0,
    );

    if (unclaimed) return unclaimed;
  }

  return null;
}

/**
 * Chooses the directory a new project will occupy.
 *
 * Separate from creation so the collision rules are testable without touching
 * the filesystem or spawning argon.
 */
export function plan(root, { name, dir, folder, gameId, argonId }) {
  const realRoot = resolveWithin(root, "");
  const parent = dir ? resolveWithin(root, dir) : realRoot;
  const base = slugify(folder || name);

  // An explicit folder name is an instruction, so it is used exactly — whatever
  // is already there gets adopted. A name derived from the place is a guess,
  // and a guess must not land on somebody else's project.
  if (folder) return { parent, folder: base, path: path.join(parent, base) };

  const chosen = uniqueName(base, (candidate) => claimedByAnother(path.join(parent, candidate), { gameId, argonId }), {
    gameId: gameId ? String(gameId) : undefined,
  });

  return { parent, folder: chosen, path: path.join(parent, chosen) };
}

/**
 * Whether a directory already belongs to a different game.
 *
 * A free path or a plain empty folder is adoptable — the common case is a user
 * who made the folder before pressing Create. A project already bound to
 * another universe is not: two games both called "Game" must not collide into
 * one directory.
 */
function claimedByAnother(candidatePath, { gameId, argonId }) {
  if (!existsSync(candidatePath)) return false;
  if (!isExistingProject(candidatePath)) return false;

  const project = readProjectFile(projectFileIn(candidatePath));

  // Unreadable or unclaimed: leave it alone rather than guess.
  if (!project) return true;
  if (project.argonId === undefined && project.gameId === undefined) return false;

  if (argonId) return project.argonId !== argonId;
  if (gameId) return Number(project.gameId) !== Number(gameId);

  return true;
}

/**
 * Writes this place's identity into an existing project file so the plugin
 * auto-connects to it from now on. Unknown keys are preserved: the file is the
 * user's, and we are only adding to it.
 */
export function claim(projectPath, { gameId, placeId, argonId }) {
  const file = projectFileIn(projectPath);
  if (!file) throw new Error(`no project file in ${projectPath}`);

  const project = readProjectFile(file);
  if (!project) throw new Error(`could not parse ${file}`);

  if (argonId) {
    project.argonId = argonId;
  } else {
    if (gameId) project.gameId = Number(gameId);
    if (placeId) {
      const ids = new Set(Array.isArray(project.placeIds) ? project.placeIds : []);
      ids.add(Number(placeId));
      project.placeIds = [...ids];
    }
  }

  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  return file;
}

/**
 * Confines a project path the caller supplied to the projects root.
 *
 * The plugin normally echoes back a path we handed it in /projects, but a path
 * from a caller is still a path from a caller.
 */
export function resolveProjectPath(root, candidate) {
  return resolveWithin(root, candidate);
}

/**
 * The projects root implied by a directory the user picked.
 *
 * Picking a project itself and getting an empty list is the mistake worth
 * absorbing: the list scans one root, so adopting the project's parent shows
 * the thing they pointed at. A folder that is not a project is taken at face
 * value and becomes the root as picked.
 */
export function rootFor(directory) {
  return isExistingProject(directory) ? path.dirname(directory) : directory;
}

/** True when the directory exists and already looks like a project. */
export function isExistingProject(directory) {
  try {
    return statSync(directory).isDirectory() && Boolean(projectFileIn(directory));
  } catch {
    return false;
  }
}

/**
 * Renames a project, in its own file.
 *
 * The folder is left alone on purpose: it is what argon serves, what git
 * tracks, and what the plugin claimed. Renaming it would break all three to
 * change a label.
 */
export function rename(projectPath, name) {
  const trimmed = String(name ?? "").trim();

  if (!trimmed) throw new Error("a project needs a name");
  if (trimmed.length > 100) throw new Error("that name is too long");

  // A full path already, not a name to join onto the directory.
  const file = projectFileIn(projectPath);
  if (!file) throw new Error(`no project file in ${projectPath}`);

  const project = JSON.parse(readFileSync(file, "utf8"));

  if (project.name === trimmed) return { path: projectPath, name: trimmed, changed: false };

  project.name = trimmed;
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);

  return { path: projectPath, name: trimmed, changed: true };
}

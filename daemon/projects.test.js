import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { browse, mkdir, list, findByIdentity, plan, claim, projectFileIn, isExistingProject, rootFor } from "./projects.js";
import { PathEscape } from "./paths.js";

let root;
const created = [];

function makeProject(directory, project = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "default.project.json"),
    JSON.stringify({ name: path.basename(directory), tree: { $className: "DataModel" }, ...project }, null, 2),
  );
  return directory;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "msync-projects-")));
  created.push(root);
});

after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

// -------------------------------------------------------------- browsing

test("browse lists directories at the root and marks projects", () => {
  makeProject(path.join(root, "race-stars"));
  mkdirSync(path.join(root, "just-a-folder"));
  mkdirSync(path.join(root, ".hidden"));
  writeFileSync(path.join(root, "loose.txt"), "x");

  const result = browse(root, "");

  assert.equal(result.parent, null, "the root must not offer a way up");
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.isProject]),
    [
      ["just-a-folder", false],
      ["race-stars", true],
    ],
    "hidden folders and loose files must not appear",
  );
});

test("browse reports a parent below the root", () => {
  mkdirSync(path.join(root, "games", "inner"), { recursive: true });
  const result = browse(root, "games");

  assert.equal(result.parent, root);
  assert.deepEqual(result.entries.map((entry) => entry.name), ["inner"]);
});

test("browse refuses to leave the root", () => {
  assert.throws(() => browse(root, ".."), PathEscape);
  assert.throws(() => browse(root, "/etc"), PathEscape);
});

// -------------------------------------------------------------- mkdir

test("mkdir creates a folder and returns its path", () => {
  const created = mkdir(root, "", "New Game");
  assert.equal(created, path.join(root, "New-Game"), "the name must be slugified");
  assert.equal(isExistingProject(created), false);
});

test("mkdir slugifies a hostile name rather than acting on it", () => {
  const created = mkdir(root, "", "../escape");
  assert.equal(path.dirname(created), root, "traversal in the name must not escape");
  assert.equal(path.basename(created), "escape");
});

test("mkdir refuses to leave the root through the parent", () => {
  assert.throws(() => mkdir(root, "..", "x"), PathEscape);
});

test("mkdir refuses to target the root itself", () => {
  assert.throws(() => mkdir(root, "", "."), /no usable characters|refusing to create/);
});

// --------------------------------------------------------------- listing

test("lists only directories that contain a project file", () => {
  makeProject(path.join(root, "alpha"));
  mkdirSync(path.join(root, "not-a-project"));

  const projects = list(root);
  assert.deepEqual(projects.map((project) => project.name), ["alpha"]);
  assert.equal(projects[0].running, false);
  assert.equal(projects[0].port, null);
});

test("reads identity and config out of the project file", () => {
  makeProject(path.join(root, "race"), {
    name: "Race Stars",
    gameId: 8899,
    placeIds: [12, 34],
    gameConfig: { "*": { TwoWaySync: true } },
  });

  const [project] = list(root);
  assert.equal(project.name, "Race Stars");
  assert.equal(project.gameId, 8899);
  assert.deepEqual(project.placeIds, [12, 34]);
  assert.deepEqual(project.gameConfig, { "*": { TwoWaySync: true } });
});

test("a malformed project file still lists, rather than vanishing", () => {
  // Losing a project from the picker because its JSON has a stray comma is a
  // worse failure than showing it with no identity.
  const directory = path.join(root, "broken");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "default.project.json"), "{ not json");

  const [project] = list(root);
  assert.equal(project.name, "broken");
  assert.equal(project.gameId, null);
  assert.deepEqual(project.placeIds, []);
});

test("running projects report their session and sort first", () => {
  makeProject(path.join(root, "aaa"));
  makeProject(path.join(root, "zzz"));

  const running = new Map([[path.join(root, "zzz"), { host: "localhost", port: 8000, startedAt: 500 }]]);
  const projects = list(root, { running });

  assert.equal(projects[0].name, "zzz", "the most recently served project comes first");
  assert.equal(projects[0].running, true);
  assert.equal(projects[0].port, 8000);
  assert.equal(projects[1].running, false);
});

test("a missing root lists nothing instead of throwing", () => {
  assert.deepEqual(list(path.join(root, "nope")), []);
});

// ------------------------------------------------------------- identity

test("matches a project by placeId, then gameId", () => {
  const projects = [
    { name: "a", gameId: 1, placeIds: [10], argonId: null },
    { name: "b", gameId: 2, placeIds: [20], argonId: null },
  ];

  assert.equal(findByIdentity(projects, { placeId: 20 }).name, "b");
  assert.equal(findByIdentity(projects, { gameId: 1 }).name, "a");
  // placeId wins when both are supplied and disagree.
  assert.equal(findByIdentity(projects, { placeId: 10, gameId: 2 }).name, "a");
  assert.equal(findByIdentity(projects, { placeId: 99 }), null);
});

test("an unpublished place matches only on its argonId", () => {
  const projects = [{ name: "a", gameId: 0, placeIds: [], argonId: "abc" }];

  assert.equal(findByIdentity(projects, { argonId: "abc" }).name, "a");
  assert.equal(findByIdentity(projects, { argonId: "different" }), null);
  // gameId 0 is every unpublished place; matching on it would connect the
  // wrong project.
  assert.equal(findByIdentity(projects, { gameId: 0 }), null);
});

// ---------------------------------------------------------------- plan

test("plans a folder from the place name", () => {
  const planned = plan(root, { name: "Race Stars" });
  assert.equal(planned.folder, "Race-Stars");
  assert.equal(planned.path, path.join(root, "Race-Stars"));
});

test("an explicit folder name overrides the place name", () => {
  assert.equal(plan(root, { name: "Race Stars", folder: "custom" }).folder, "custom");
});

test("an empty folder or unclaimed project is adopted, not suffixed", () => {
  // The common case is a user who made the folder before pressing Create.
  mkdirSync(path.join(root, "Race-Stars"));
  assert.equal(plan(root, { name: "Race Stars", gameId: 8899 }).folder, "Race-Stars");

  makeProject(path.join(root, "Unclaimed"));
  assert.equal(plan(root, { name: "Unclaimed", gameId: 8899 }).folder, "Unclaimed");
});

test("a project claimed by another game is skipped, not hijacked", () => {
  makeProject(path.join(root, "Race-Stars"), { gameId: 1111 });
  assert.equal(plan(root, { name: "Race Stars", gameId: 8899 }).folder, "Race-Stars-8899");

  makeProject(path.join(root, "Race-Stars-8899"), { gameId: 2222 });
  assert.equal(plan(root, { name: "Race Stars", gameId: 8899 }).folder, "Race-Stars-2");
});

test("an unpublished place skips a project claimed by a different argonId", () => {
  makeProject(path.join(root, "Untitled"), { argonId: "someone-else" });
  assert.equal(plan(root, { name: "Untitled", argonId: "mine" }).folder, "Untitled-2");
});

test("an explicit folder is used exactly, however occupied", () => {
  makeProject(path.join(root, "chosen"), { gameId: 1111 });
  assert.equal(plan(root, { name: "Race Stars", folder: "chosen", gameId: 8899 }).folder, "chosen");
});

test("plans inside a chosen subdirectory", () => {
  mkdirSync(path.join(root, "games"));
  const planned = plan(root, { name: "Race Stars", dir: "games" });
  assert.equal(planned.path, path.join(root, "games", "Race-Stars"));
});

test("planning refuses a directory outside the root", () => {
  assert.throws(() => plan(root, { name: "x", dir: "../elsewhere" }), PathEscape);
  assert.throws(() => plan(root, { name: "x", dir: "/tmp" }), PathEscape);
});

test("planning refuses a name with nothing usable", () => {
  assert.throws(() => plan(root, { name: "!!!" }), /no usable characters/);
});

// --------------------------------------------------------------- claim

test("claim writes place identity without discarding unknown keys", () => {
  const directory = makeProject(path.join(root, "race"), {
    name: "Race Stars",
    somethingWeDoNotKnowAbout: { keep: true },
  });

  claim(directory, { gameId: 8899, placeId: 12 });

  const written = JSON.parse(readFileSync(projectFileIn(directory), "utf8"));
  assert.equal(written.gameId, 8899);
  assert.deepEqual(written.placeIds, [12]);
  assert.deepEqual(written.somethingWeDoNotKnowAbout, { keep: true }, "the file is the user's, not ours to prune");
  assert.deepEqual(written.tree, { $className: "DataModel" });
});

test("claim adds a place id without dropping the existing ones", () => {
  const directory = makeProject(path.join(root, "race"), { gameId: 8899, placeIds: [12] });
  claim(directory, { gameId: 8899, placeId: 34 });

  const written = JSON.parse(readFileSync(projectFileIn(directory), "utf8"));
  assert.deepEqual(written.placeIds, [12, 34]);
});

test("claim does not duplicate a place id it already has", () => {
  const directory = makeProject(path.join(root, "race"), { placeIds: [12] });
  claim(directory, { placeId: 12 });

  const written = JSON.parse(readFileSync(projectFileIn(directory), "utf8"));
  assert.deepEqual(written.placeIds, [12]);
});

test("claim writes an argonId for an unpublished place", () => {
  const directory = makeProject(path.join(root, "race"));
  claim(directory, { argonId: "abc-123" });

  const written = JSON.parse(readFileSync(projectFileIn(directory), "utf8"));
  assert.equal(written.argonId, "abc-123");
  assert.equal(written.gameId, undefined, "an unpublished place has no game identity to record");
});

test("claim fails loudly on a directory that is not a project", () => {
  mkdirSync(path.join(root, "empty"));
  assert.throws(() => claim(path.join(root, "empty"), { placeId: 1 }), /no project file/);
});

// ------------------------------------------------------- project detection

test("detects a project by any *.project.json, not just default", () => {
  const directory = path.join(root, "custom");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "dev.project.json"), "{}");

  assert.ok(projectFileIn(directory));
  assert.equal(isExistingProject(directory), true);
});

test("a symlinked root is resolved, not refused", () => {
  // The user's projects folder is often a symlink into iCloud or an external
  // drive; refusing that would be wrong.
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  makeProject(path.join(real, "game"));
  symlinkSync(real, link);

  assert.deepEqual(list(link).map((project) => project.name), ["game"]);
});

// ------------------------------------------------------------- rootFor

test("picking a project adopts its parent as the root", () => {
  // Otherwise the user points at their project and gets an empty list, because
  // the root is scanned one level deep.
  const project = path.join(root, "my-game");
  makeProject(project);

  assert.equal(rootFor(project), root);
});

test("picking a plain folder takes it at face value", () => {
  const folder = path.join(root, "somewhere");
  mkdirSync(folder, { recursive: true });

  assert.equal(rootFor(folder), folder);
});

test("a folder that merely contains projects stays the root", () => {
  // The containing folder is not itself a project, so it must not be walked up
  // past — that would show the user a level above what they picked.
  makeProject(path.join(root, "a"));
  makeProject(path.join(root, "b"));

  assert.equal(rootFor(root), root);
});

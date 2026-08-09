import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { list, findByIdentity } from "./projects.js";
import { read, register } from "./registry.js";
import { createRoutes } from "./routes.js";
import { makeProject, freshRoot, cleanupRoots } from "./projects.fixture.js";

let root;
let elsewhere;
let registry;

beforeEach(() => {
  root = freshRoot();
  elsewhere = freshRoot();
  // Never the real ~/.muslimsync. The file is a parameter precisely so a test
  // can point it at a directory it owns and throws away.
  registry = path.join(freshRoot(), "projects.json");
});

after(cleanupRoots);

/** The names in the list, sorted, which is all most of these tests care about. */
function names(options = { registry }) {
  return list(root, options)
    .map((project) => project.name)
    .sort();
}

// -------------------------------------------------------------- the union

test("a registered project the scan cannot reach is listed with the scanned ones", () => {
  // The real failure: the create dialog accepts a subfolder, and list() reads
  // only the direct children of the root, so the project synced fine and never
  // appeared again.
  makeProject(path.join(root, "alpha"));
  const nested = makeProject(path.join(root, "Scratch", "zombieswithoutmap"));

  assert.deepEqual(names(), ["alpha"], "the scan alone cannot see a nested project");

  assert.equal(register(registry, root, nested), true);
  assert.deepEqual(names(), ["alpha", "zombieswithoutmap"]);
});

test("a registered project outside the root entirely is listed too", () => {
  const outside = makeProject(path.join(elsewhere, "adopted"));
  register(registry, root, outside);

  const [project] = list(root, { registry });
  assert.equal(project.path, outside);
});

test("a registered project is read the same way a scanned one is", () => {
  const nested = makeProject(path.join(root, "sub", "race"), {
    name: "Race Stars",
    gameId: 8899,
    placeIds: [12],
    tree: { $className: "DataModel", ServerStorage: { $path: "src/ServerStorage" } },
  });
  register(registry, root, nested);

  const [project] = list(root, { registry });
  assert.equal(project.name, "Race Stars");
  assert.equal(project.gameId, 8899);
  assert.deepEqual(project.placeIds, [12]);
  assert.deepEqual(project.services, ["ServerStorage"]);
  assert.equal(project.running, false);
});

test("a registered project that is serving reports its session", () => {
  const nested = makeProject(path.join(root, "sub", "served"));
  register(registry, root, nested);

  const running = new Map([[nested, { host: "localhost", port: 8000, startedAt: 500 }]]);
  const [project] = list(root, { running, registry });

  assert.equal(project.running, true);
  assert.equal(project.port, 8000);
});

test("a registered path that is also a direct child appears once", () => {
  // register() refuses a direct child, but the root can be changed afterwards,
  // and a project must never be listed twice.
  const direct = makeProject(path.join(root, "both"));
  writeFileSync(registry, JSON.stringify([direct]));

  const projects = list(root, { registry });
  assert.deepEqual(projects.map((project) => project.path), [direct]);
});

test("identity matching sees a registered project, so it is not duplicated", () => {
  // The reason this has to be persisted at all: findByIdentity reads list(), so
  // without the registry a restart could not reattach the place to its project
  // and would scaffold a second one beside it.
  const nested = makeProject(path.join(root, "sub", "lobby"), { name: "Lobby", gameId: 500, placeIds: [11] });
  register(registry, root, nested);

  assert.equal(findByIdentity(list(root, { registry }), { gameId: 500, placeId: 11 })?.path, nested);
});

test("omitting the registry lists the scan only", () => {
  // The headless daemon has no state directory, and a project it serves is
  // meant to work for as long as it is serving rather than not at all.
  makeProject(path.join(root, "alpha"));
  register(registry, root, makeProject(path.join(root, "sub", "hidden")));

  assert.deepEqual(names({}), ["alpha"]);
});

// ------------------------------------------------------------- pruning

test("a registered project that has been deleted is skipped and pruned", () => {
  const gone = makeProject(path.join(root, "sub", "gone"));
  register(registry, root, gone);
  rmSync(gone, { recursive: true, force: true });

  assert.deepEqual(names(), [], "a project that is not there must not be listed");
  assert.deepEqual(read(registry), [], "and must not accumulate in the file");
});

test("a registered folder that lost its project file is pruned as well", () => {
  // Not a project any more is the same as gone: it cannot be served, so nothing
  // is lost by forgetting where it was.
  const emptied = path.join(root, "sub", "emptied");
  mkdirSync(emptied, { recursive: true });
  register(registry, root, emptied);

  assert.deepEqual(names(), []);
  assert.deepEqual(read(registry), []);
});

test("pruning one entry leaves the others alone", () => {
  const kept = makeProject(path.join(root, "sub", "kept"));
  const gone = makeProject(path.join(root, "sub", "gone"));
  register(registry, root, kept);
  register(registry, root, gone);
  rmSync(gone, { recursive: true, force: true });

  assert.deepEqual(names(), ["kept"]);
  assert.deepEqual(read(registry), [kept]);
});

// ------------------------------------------------------------ registering

test("registering the same path twice records it once", () => {
  const nested = makeProject(path.join(root, "sub", "once"));

  assert.equal(register(registry, root, nested), true);
  assert.equal(register(registry, root, nested), false, "the second call has nothing to add");
  assert.deepEqual(read(registry), [nested]);
});

test("a direct child of the root is not registered", () => {
  // The scan already finds it, and a second source of truth for the same
  // project is what keeps this file small enough to be trustworthy.
  const direct = makeProject(path.join(root, "scanned"));

  assert.equal(register(registry, root, direct), false);
  assert.equal(existsSync(registry), false, "nothing to record means nothing written");
});

test("a root named in a different case still recognises its own children", () => {
  // Windows treats C:\Users and c:\users as one directory, so the root the user
  // typed in Settings and the path realpath returned can differ in case.
  const direct = makeProject(path.join(root, "scanned"));
  const shouted = process.platform === "win32" ? root.toUpperCase() : root;

  assert.equal(register(registry, shouted, direct), false);
});

test("a root that does not exist yet does not stop a path being recorded", () => {
  const nested = makeProject(path.join(elsewhere, "orphan"));

  assert.equal(register(registry, path.join(root, "not-created-yet"), nested), true);
  assert.deepEqual(read(registry), [nested]);
});

test("a path reached through a symlink is stored resolved", (t) => {
  // The scan resolves symlinks, so a stored path that did not would list the
  // same project twice. macOS reaches temp and home directories through one
  // routinely: /var going in, /private/var coming back.
  const real = makeProject(path.join(elsewhere, "real"));
  const link = path.join(elsewhere, "link");

  try {
    symlinkSync(real, link, "dir");
  } catch {
    // Windows refuses symlinks without elevation, which is not what this is
    // about — the comparison itself is covered by paths.test.js.
    t.skip("symlinks are not available here");
    return;
  }

  register(registry, root, link);
  assert.deepEqual(read(registry), [real]);
});

test("no registry file means nothing is recorded and nothing throws", () => {
  assert.equal(register(null, root, makeProject(path.join(elsewhere, "nowhere"))), false);
});

// -------------------------------------------------------------- bad files

test("a corrupt registry file is treated as empty", () => {
  makeProject(path.join(root, "alpha"));
  writeFileSync(registry, "{ not json");

  assert.deepEqual(read(registry), []);
  assert.deepEqual(names(), ["alpha"], "a bad file must not take the listing down with it");
});

test("a registry file holding the wrong shape is treated as empty", () => {
  writeFileSync(registry, JSON.stringify({ projects: ["/somewhere"] }));
  assert.deepEqual(read(registry), []);

  writeFileSync(registry, JSON.stringify([1, null, ""]));
  assert.deepEqual(read(registry), [], "entries that are not paths are not paths");
});

test("a corrupt file is replaced rather than appended to", () => {
  const nested = makeProject(path.join(root, "sub", "after"));
  writeFileSync(registry, "]]not json[[");

  assert.equal(register(registry, root, nested), true);
  assert.deepEqual(read(registry), [nested]);
});

// ------------------------------------------------------------ the create flow

/** Records starts, never spawns argon. Mirrors the fake in routes.test.js. */
function fakeArgon(started) {
  const running = new Map();
  return {
    running,
    start: async (projectPath) => {
      started.push(projectPath);
      const session = { host: "localhost", port: 8000, startedAt: 1000 };
      running.set(projectPath, session);
      return session;
    },
  };
}

/**
 * Creates through the route, with the folder already a project.
 *
 * An existing project is adopted rather than scaffolded, which keeps the real
 * `argon init` out of these tests — what is under test is the registration.
 */
async function createProject(body) {
  const started = [];
  const routes = createRoutes({ projectsRoot: () => root, argon: fakeArgon(started), registry });
  const result = await routes["POST /createProject"](body);

  return { ...result, started };
}

test("creating a project in a subfolder registers it", async () => {
  const nested = makeProject(path.join(root, "Scratch", "zombieswithoutmap"));

  const created = await createProject({
    name: "Zombies",
    dir: "Scratch",
    folder: "zombieswithoutmap",
    gameId: 131,
    placeId: 665,
  });

  assert.equal(created.path, nested);
  assert.deepEqual(read(registry), [nested], "otherwise a restart loses it");
  assert.deepEqual(created.started, [nested]);
});

test("creating a project directly under the root registers nothing", async () => {
  const direct = makeProject(path.join(root, "plain"));

  const created = await createProject({ name: "Plain", folder: "plain", gameId: 132, placeId: 666 });

  assert.equal(created.path, direct);
  assert.equal(existsSync(registry), false, "the scan already finds it");
});

test("serving a project in a subfolder registers it", async () => {
  // A project the user never created here — only ever served — is exactly the
  // one that would otherwise be forgotten on the next restart.
  const nested = makeProject(path.join(root, "Scratch", "served"));
  const routes = createRoutes({ projectsRoot: () => root, argon: fakeArgon([]), registry });

  await routes["POST /startProject"]({ path: nested });

  assert.deepEqual(read(registry), [nested]);
});

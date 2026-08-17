import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode, decode } from "@msgpack/msgpack";

import { Daemon } from "./index.js";
import { createRoutes } from "./routes.js";
import { projectFileIn } from "./projects.js";

let root;
let daemon;
let started;
let logged;
let changes;
const temporary = [];

/** Stands in for ArgonProcesses: records starts, never spawns anything. */
function fakeArgon() {
  const running = new Map();
  return {
    running,
    start: async (projectPath) => {
      started.push(projectPath);
      const session = { host: "localhost", port: 8000 + started.length, startedAt: 1000 };
      running.set(projectPath, session);
      return session;
    },
  };
}

function makeProject(directory, project = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "default.project.json"),
    JSON.stringify({ name: path.basename(directory), tree: { $className: "DataModel" }, ...project }, null, 2),
  );
  return directory;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "msync-routes-")));
  temporary.push(root);
  started = [];
  logged = [];
  changes = 0;

  daemon = new Daemon({
    port: 0,
    routes: createRoutes({
      projectsRoot: () => root,
      argon: fakeArgon(),
      log: (entry) => logged.push(entry),
      changed: () => (changes += 1),
    }),
  });

  await daemon.start();
});

afterEach(async () => {
  // Each test gets a fresh daemon, so each must be stopped. Leaking one keeps
  // its listener open and the test process never exits.
  await daemon?.stop();
  daemon = null;
});

after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** Calls a route the way the plugin does: MsgPack in, MsgPack out. */
async function call(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { "content-type": "application/msgpack" },
    body: body === undefined ? undefined : Buffer.from(encode(body)),
  });

  return { status: response.status, value: decode(new Uint8Array(await response.arrayBuffer())) };
}

// ---------------------------------------------------------------- /projects

test("GET /projects returns MsgPack the plugin can decode", async () => {
  makeProject(path.join(root, "race"), { name: "Race Stars", gameId: 8899, placeIds: [12] });

  const { status, value } = await call("GET", "/projects");

  assert.equal(status, 200);
  assert.equal(value.length, 1);
  assert.equal(value[0].name, "Race Stars");
  assert.deepEqual(value[0].placeIds, [12]);
  assert.equal(value[0].running, false);
});

test("GET /projects is an empty list, not an error, with no projects", async () => {
  const { status, value } = await call("GET", "/projects");
  assert.equal(status, 200);
  assert.deepEqual(value, []);
});

// ----------------------------------------------------------------- /browse

test("POST /browse lists folders and flags projects", async () => {
  makeProject(path.join(root, "race"));
  mkdirSync(path.join(root, "empty"));

  const { value } = await call("POST", "/browse", { path: "" });

  assert.equal(value.parent, null);
  assert.deepEqual(value.entries.map((entry) => [entry.name, entry.isProject]), [
    ["empty", false],
    ["race", true],
  ]);
});

test("POST /browse refuses to leave the root, with a 400 not a 500", async () => {
  // The plugin displays this message; a refused path is the caller's fault and
  // must not read as an internal error.
  const { status, value } = await call("POST", "/browse", { path: "../.." });

  assert.equal(status, 400);
  assert.equal(value.code, "PROJECT_PATH_ESCAPE");
});

// ------------------------------------------------------------------ /mkdir

test("POST /mkdir creates a slugified folder and returns its path", async () => {
  const { status, value } = await call("POST", "/mkdir", { path: "", name: "New Game" });

  assert.equal(status, 200);
  assert.equal(value, path.join(root, "New-Game"));
  assert.ok(existsSync(value));
});

test("POST /mkdir will not be talked out of the root", async () => {
  const { status } = await call("POST", "/mkdir", { path: "../..", name: "escape" });
  assert.equal(status, 400);
  assert.equal(existsSync(path.join(path.dirname(root), "escape")), false);
});

// -------------------------------------------------------------------- /log

test("POST /log records the entry and always succeeds", async () => {
  // The plugin calls this from inside its own logger, so a failure here could
  // recurse. It must never be the thing that throws.
  const { status } = await call("POST", "/log", { level: "warn", message: "hi", source: "Place (1)" });

  assert.equal(status, 200);
  assert.deepEqual(logged, [{ level: "warn", message: "hi", source: "Place (1)" }]);
});

test("POST /log tolerates a body with nothing in it", async () => {
  const { status } = await call("POST", "/log", {});
  assert.equal(status, 200);
  assert.equal(logged[0].level, "info");
});

// ----------------------------------------------------------- /startProject

test("POST /startProject serves an existing project", async () => {
  const directory = makeProject(path.join(root, "race"));

  const { status, value } = await call("POST", "/startProject", { path: directory });

  assert.equal(status, 200);
  assert.equal(value.host, "localhost");
  assert.ok(value.port >= 8000);
  assert.deepEqual(started, [directory]);
});

test("POST /startProject refuses a directory that is not a project", async () => {
  mkdirSync(path.join(root, "empty"));
  const { status } = await call("POST", "/startProject", { path: path.join(root, "empty") });

  assert.equal(status, 404);
  assert.deepEqual(started, []);
});

test("POST /startProject refuses a path outside the root", async () => {
  const { status } = await call("POST", "/startProject", { path: "/etc" });
  assert.equal(status, 400);
  assert.deepEqual(started, [], "argon must never be pointed outside the projects root");
});

test("POST /startProject requires a path", async () => {
  const { status } = await call("POST", "/startProject", {});
  assert.equal(status, 400);
});

// ---------------------------------------------------------- /createProject

test("POST /createProject scaffolds, claims the place, and serves it", async () => {
  const { status, value } = await call("POST", "/createProject", {
    name: "Race Stars",
    gameId: 8899,
    placeId: 12,
  });

  assert.equal(status, 200);
  assert.equal(value.path, path.join(root, "Race-Stars"));
  assert.ok(value.port >= 8000);

  // Scaffolding shells out to the real argon, so this asserts a genuine project.
  const file = projectFileIn(value.path);
  assert.ok(file, "argon init must have produced a project file");

  const project = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(project.gameId, 8899);
  assert.deepEqual(project.placeIds, [12]);
});

test("creating twice for one universe returns the same project", async () => {
  const first = await call("POST", "/createProject", { name: "Race Stars", gameId: 8899, placeId: 12 });
  const second = await call("POST", "/createProject", { name: "Race Stars", gameId: 8899, placeId: 12 });

  assert.equal(second.value.path, first.value.path, "a second copy of one game is never what the user wanted");
  assert.equal(started.length, 2, "but it is served again");
});

test("an unclaimed existing folder is adopted rather than refused", async () => {
  // The fork's master learned this: a user who made the folder first should
  // not be stuck. The folder has no identity yet, so it is ours to adopt.
  const directory = makeProject(path.join(root, "Race-Stars"), { name: "Mine" });

  const { status, value } = await call("POST", "/createProject", { name: "Race Stars", gameId: 8899 });

  assert.equal(status, 200);
  assert.equal(value.path, directory);

  const project = JSON.parse(readFileSync(projectFileIn(directory), "utf8"));
  assert.equal(project.name, "Mine", "adopting must not overwrite the user's project file");
  assert.equal(project.gameId, 8899, "but the identity is claimed");
});

test("a folder already claimed by another game is never hijacked", async () => {
  // Two games both called "Game" must not collide into one directory.
  makeProject(path.join(root, "Race-Stars"), { gameId: 1111 });

  const { value } = await call("POST", "/createProject", { name: "Race Stars", gameId: 8899 });

  assert.equal(value.path, path.join(root, "Race-Stars-8899"));

  const other = JSON.parse(readFileSync(projectFileIn(path.join(root, "Race-Stars")), "utf8"));
  assert.equal(other.gameId, 1111, "the other game's project must be untouched");
});

test("an explicit folder name is used exactly, adopting what is there", async () => {
  // An explicit folder is an instruction; a derived name is a guess.
  makeProject(path.join(root, "chosen"), { name: "Mine" });

  const { value } = await call("POST", "/createProject", { name: "Race Stars", folder: "chosen", gameId: 8899 });

  assert.equal(value.path, path.join(root, "chosen"));
});

test("plain empty folders are adoptable", async () => {
  mkdirSync(path.join(root, "Race-Stars"));

  const { value } = await call("POST", "/createProject", { name: "Race Stars", gameId: 8899 });

  assert.equal(value.path, path.join(root, "Race-Stars"), "an empty folder the user made is the common case");
  assert.ok(projectFileIn(value.path), "and it gets scaffolded");
});

test("an unpublished place is claimed by argonId", async () => {
  const { value } = await call("POST", "/createProject", { name: "Untitled", argonId: "abc-123" });

  const project = JSON.parse(readFileSync(projectFileIn(value.path), "utf8"));
  assert.equal(project.argonId, "abc-123");
  assert.equal(project.gameId, undefined);
});

test("POST /createProject refuses a directory outside the root", async () => {
  const { status } = await call("POST", "/createProject", { name: "x", dir: "../../tmp" });
  assert.equal(status, 400);
});

test("POST /createProject refuses a name with nothing usable", async () => {
  const { status, value } = await call("POST", "/createProject", { name: "!!!" });
  assert.equal(status, 400);
  assert.equal(value.code, "INVALID_NAME");
});

// ------------------------------------------------------------------ framing

test("an empty body arrives as an array and is read as an empty map", async () => {
  // Lua cannot distinguish an empty map from an empty array, and the plugin's
  // encoder picks array. `{path = nil}` is exactly how the folder browser asks
  // for the project roots, so rejecting [] broke root browsing in Studio.
  makeProject(path.join(root, "race"));

  const response = await fetch(`http://127.0.0.1:${daemon.port}/browse`, {
    method: "POST",
    body: Buffer.from(encode([])),
  });

  assert.equal(response.status, 200);
  const value = decode(new Uint8Array(await response.arrayBuffer()));
  assert.equal(value.path, root);
  assert.deepEqual(value.entries.map((entry) => entry.name), ["race"]);
});

test("a non-empty array body is still refused", async () => {
  // Only the empty case is ambiguous; a populated array is genuinely wrong.
  const response = await fetch(`http://127.0.0.1:${daemon.port}/browse`, {
    method: "POST",
    body: Buffer.from(encode([1, 2, 3])),
  });

  assert.equal(response.status, 400);
});

test("a malformed body is rejected without taking the daemon down", async () => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/browse`, {
    method: "POST",
    body: Buffer.from([0xc1, 0xff, 0xff]),
  });

  assert.equal(response.status, 400);

  // Still serving afterwards.
  const { status } = await call("GET", "/projects");
  assert.equal(status, 200);
});

test("unknown routes still fall through to /health", async () => {
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).listening, true);
});

// ------------------------------------------------- announcing to the app

test("creating a project announces the change", async () => {
  // Without this the app's list only refreshed when a plugin connected, so a
  // project created from the plugin stayed invisible until something unrelated
  // happened.
  await call("POST", "/createProject", { name: "Announced", gameId: 5, placeId: 6 });

  assert.ok(changes > 0, "expected at least one change notification");
});

test("serving an existing project announces it too", async () => {
  // Whether a project is serving is part of what the list shows.
  const created = await call("POST", "/createProject", { name: "ServeMe", gameId: 7, placeId: 8 });
  const before = changes;

  const { status } = await call("POST", "/startProject", { path: created.value.path });

  assert.equal(status, 200);
  assert.ok(changes > before, "serving must refresh the list");
});

test("a new project is scaffolded with the agent brief", async () => {
  // An agent working in a game repository has no reason to know msync exists,
  // so the brief travels with the project rather than waiting in this one.
  const created = await call("POST", "/createProject", { name: "Briefed", gameId: 900, placeId: 901 });
  const brief = path.join(created.value.path, "AGENTS.md");

  assert.ok(existsSync(brief), "expected AGENTS.md in the new project");
  assert.match(readFileSync(brief, "utf8"), /## MuslimSync/);

  // Claude Code reads CLAUDE.md and never AGENTS.md, so a project created here
  // needs the same bridge `msync agents --install` writes.
  assert.match(readFileSync(path.join(created.value.path, "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
});

test("a new project maps the services that hold code", async () => {
  // argon init writes three, which leaves ServerStorage with no file behind it
  // — invisible to git, to grep, and to an agent's file tools.
  const created = await call("POST", "/createProject", { name: "Wide", gameId: 700, placeId: 701 });
  const file = path.join(created.value.path, "default.project.json");
  const project = JSON.parse(readFileSync(file, "utf8"));

  for (const service of ["ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui"]) {
    assert.ok(project.tree[service], `${service} should be mapped`);
  }
});

test("Workspace is left unmapped on purpose", async () => {
  // Mapping it serialises every part to disk: enormous, rewritten whenever a
  // model is nudged, and merge conflicts nobody can read.
  const created = await call("POST", "/createProject", { name: "NoWorkspace", gameId: 702, placeId: 703 });
  const project = JSON.parse(readFileSync(path.join(created.value.path, "default.project.json"), "utf8"));

  assert.equal(project.tree.Workspace, undefined);
});

test("a service argon already mapped is left alone", async () => {
  // Overwriting it would move someone's files.
  const created = await call("POST", "/createProject", { name: "Keep", gameId: 704, placeId: 705 });
  const project = JSON.parse(readFileSync(path.join(created.value.path, "default.project.json"), "utf8"));

  assert.equal(project.tree.ReplicatedStorage.$path, "src/Shared", "argon's own mapping must survive");
});

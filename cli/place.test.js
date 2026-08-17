import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findProjectFile, projectIdentity, inferPlace } from "./place.js";
import { resolveTarget } from "./target.js";

const temporary = [];
after(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(contents, file = "default.project.json") {
  const root = mkdtempSync(path.join(tmpdir(), "msync-place-"));
  temporary.push(root);

  if (contents !== null) writeFileSync(path.join(root, file), contents);
  mkdirSync(path.join(root, "src", "Shared"), { recursive: true });

  return { root, deep: path.join(root, "src", "Shared") };
}

const plugin = (over = {}) => ({ ref: "r", placeId: "0", gameId: "0", argonId: null, placeName: null, ...over });

// ------------------------------------------------------------- finding it

test("the project file is found from a subdirectory", () => {
  // An agent runs from wherever it happens to be, usually not the root.
  const { root, deep } = project('{"name":"x"}');
  assert.equal(findProjectFile(deep), path.join(root, "default.project.json"));
});

test("any *.project.json counts, but default wins", () => {
  const { root } = project('{"name":"other"}', "other.project.json");
  assert.equal(findProjectFile(root), path.join(root, "other.project.json"));

  writeFileSync(path.join(root, "default.project.json"), '{"name":"default"}');
  assert.equal(findProjectFile(root), path.join(root, "default.project.json"));
});

test("no project anywhere above is null, not an error", () => {
  const { root } = project(null);
  assert.equal(findProjectFile(root), null);
});

test("a project file that will not parse tells us nothing", () => {
  // Guessing the place from a broken file is worse than asking.
  const { root } = project("{ not json");
  assert.equal(projectIdentity(findProjectFile(root)), null);
});

// ------------------------------------------------------------- matching

test("a placeId names exactly one place", () => {
  const identity = { placeIds: ["131"], gameId: "9", argonId: null };
  const open = [plugin({ ref: "131", placeId: "131" }), plugin({ ref: "999", placeId: "999" })];

  assert.equal(inferPlace(open, identity).ref, "131");
});

test("an unpublished place is matched by its marker", () => {
  // Its placeId is 0, same as every other unpublished place.
  const identity = { placeIds: [], gameId: null, argonId: "aaaa-1111" };
  const open = [plugin({ ref: "aaaa1111", argonId: "aaaa-1111" }), plugin({ ref: "2" })];

  assert.equal(inferPlace(open, identity).ref, "aaaa1111");
});

test("a gameId matches only while one place of that universe is open", () => {
  // A universe holds many places; two open means the directory has not said
  // which, and picking one would be the guess this exists to prevent.
  const identity = { placeIds: [], gameId: "77", argonId: null };

  const one = [plugin({ ref: "a", gameId: "77" }), plugin({ ref: "b", gameId: "88" })];
  assert.equal(inferPlace(one, identity).ref, "a");

  const two = [plugin({ ref: "a", gameId: "77" }), plugin({ ref: "b", gameId: "77" })];
  assert.equal(inferPlace(two, identity), null);
});

test("a directory with no matching place open infers nothing", () => {
  const identity = { placeIds: ["131"], gameId: "9", argonId: null };
  assert.equal(inferPlace([plugin({ ref: "999", placeId: "999" })], identity), null);
});

test("nothing connected, or no project, infers nothing", () => {
  assert.equal(inferPlace([], { placeIds: ["1"], gameId: null, argonId: null }), null);
  assert.equal(inferPlace([plugin()], null), null);
});

test("placeId beats gameId when both could match", () => {
  // The more specific identifier wins: a universe is not a place.
  const identity = { placeIds: ["131"], gameId: "77", argonId: null };
  const open = [plugin({ ref: "other", gameId: "77" }), plugin({ ref: "131", placeId: "131", gameId: "77" })];

  assert.equal(inferPlace(open, identity).ref, "131");
});

test("source is refused based on the target place's project, not cwd", async (t) => {
  // The guard used to key off the caller's working directory, so an agent
  // running from its own workspace read synced code through Studio without
  // ever seeing the refusal. The mapping belongs to the place being read.
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { resolveTarget } = await import("./target.js");

  const root = mkdtempSync(path.join(tmpdir(), "msync-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const project = path.join(root, "ZombiesProject");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "default.project.json"),
    JSON.stringify({
      name: "zombies",
      tree: { $className: "DataModel", ReplicatedStorage: { $path: "src/Shared" } },
      placeIds: [131665072265325],
    }),
  );

  const send = async () => ({
    body: Buffer.from(
      JSON.stringify({
        serving: [project],
        target: "131665072265325",
        plugins: [{ ref: "131665072265325", placeId: "131665072265325", gameId: "1", argonId: null }],
      }),
    ),
  });

  class Fatal extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // cwd is this repo — no project file names that place. The refusal must
  // come from the served project anyway.
  await assert.rejects(
    () =>
      resolveTarget({
        command: "source",
        positionals: ["ReplicatedStorage/SharedModules/Interactables"],
        flags: {},
        port: 0,
        send,
        Fatal,
        EXIT: { usage: 2 },
      }),
    /this place is synced/,
  );

  // A path outside the mapped services is still allowed through.
  const allowed = await resolveTarget({
    command: "source",
    positionals: ["ServerStorage/Secrets"],
    flags: {},
    port: 0,
    send,
    Fatal,
    EXIT: { usage: 2 },
  });
  assert.equal(allowed, undefined);
});

// ------------------------------------------------------------- resolving

class Fatal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EXIT = { usage: 2 };

/** A daemon that answers /health with the given state, and nothing else. */
const daemon = (state) => async () => ({ body: Buffer.from(JSON.stringify(state)) });

/** Runs from inside a directory, and puts the old one back afterwards. */
function inside(directory, t) {
  const previous = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(previous));
}

/** What was written to stderr while `run` ran, alongside its answer. */
async function withStderr(run) {
  const original = process.stderr.write;
  let notice = "";

  process.stderr.write = (chunk) => {
    notice += String(chunk);
    return true;
  };

  try {
    return { place: await run(), notice };
  } finally {
    process.stderr.write = original;
  }
}

const mapped = (over) =>
  JSON.stringify({
    name: "x",
    tree: { $className: "DataModel", ReplicatedStorage: { $path: "src/Shared" } },
    ...over,
  });

/** resolveTarget with the plumbing every case below passes identically. */
const target = (command, flags, send, positionals = ["ReplicatedStorage/Thing"]) =>
  resolveTarget({ command, positionals, flags, port: 0, send, Fatal, EXIT });

test("a read with no --place runs in this directory's place", async (t) => {
  // Reads used to skip the working directory and take the daemon's default, on
  // the theory that reading the wrong place is obvious. It is not: an agent in
  // its own project got answers about one of the other open places, with
  // nothing on screen to say so.
  const { deep } = project(JSON.stringify({ name: "b", placeIds: [95380500475433] }));
  inside(deep, t);

  const send = daemon({
    target: "131665072265325",
    serving: [],
    plugins: [
      plugin({ ref: "131665072265325", placeId: "131665072265325" }),
      plugin({ ref: "95380500475433", placeId: "95380500475433", placeName: "Zombies-2" }),
    ],
  });

  const { place, notice } = await withStderr(() => target("get", {}, send, ["Workspace"]));

  assert.equal(place, "95380500475433");
  assert.match(notice, /using Zombies-2 — this directory's place/);
});

test("only one place open says nothing, and --place still wins", async (t) => {
  const { root } = project(JSON.stringify({ name: "b", placeIds: [1] }));
  inside(root, t);

  const send = daemon({ target: "1", serving: [], plugins: [plugin({ ref: "1", placeId: "1" })] });
  const alone = await withStderr(() => target("get", {}, send, ["Workspace"]));

  assert.equal(alone.place, "1");
  assert.equal(alone.notice, "", "one place open is not worth a line of output");
  assert.equal(await target("get", { place: "9" }, send), "9", "an explicit --place is never second-guessed");
});

test("a read from outside any project still falls back to the default", async (t) => {
  // Nothing to infer from, and a read has nothing to undo — so it goes where it
  // always went, which is whichever place the daemon picks.
  const { root } = project(null);
  inside(root, t);

  const send = daemon({
    target: "1",
    serving: [],
    plugins: [plugin({ ref: "1", placeId: "1" }), plugin({ ref: "2", placeId: "2" })],
  });

  assert.equal(await target("get", {}, send, ["Workspace"]), undefined);
});

test("a write takes this directory's place, and refuses without one", async (t) => {
  const send = daemon({
    target: "1",
    serving: [],
    plugins: [plugin({ ref: "1", placeId: "1" }), plugin({ ref: "2", placeId: "2" })],
  });

  const write = (flags) => target("rm", flags, send, ["Workspace/Box"]);
  inside(project(JSON.stringify({ name: "b", placeIds: [2] })).root, t);

  assert.equal((await withStderr(() => write({}))).place, "2");
  assert.equal(await write({ place: "1" }), "1");

  // Outside any project the refusal is what it always was.
  process.chdir(project(null).root);
  await assert.rejects(() => write({}), /2 places are connected, so rm needs --place/);
});

test("the source guard picks the served project by place, not by universe", async () => {
  // Two places of one universe, each with its own folder. The guard accepted a
  // gameId match, so the first-served project answered for its sibling and the
  // refusal named a folder this place was never synced to.
  const a = project(mapped({ name: "a", gameId: 10606654767, placeIds: [131665072265325] }));
  const b = project(mapped({ name: "b", gameId: 10606654767, placeIds: [95380500475433] }));

  const send = daemon({
    target: "131665072265325",
    serving: [a.root, b.root],
    plugins: [
      plugin({ ref: "131665072265325", placeId: "131665072265325", gameId: "10606654767" }),
      plugin({ ref: "95380500475433", placeId: "95380500475433", gameId: "10606654767" }),
    ],
  });

  await assert.rejects(
    () => target("source", { place: "95380500475433" }, send),
    (error) => {
      assert.match(error.message, /this place is synced/);
      assert.ok(error.message.includes(path.basename(b.root)), `named the wrong folder:\n${error.message}`);
      assert.ok(!error.message.includes(path.basename(a.root)), `named the sibling's folder:\n${error.message}`);
      return true;
    },
  );
});

test("a gameId alone only claims a place for a project with no placeIds", async () => {
  // Create-then-claim: the folder is served before its place has ever checked
  // in, so there is nothing more specific to match on.
  const { root } = project(mapped({ name: "fresh", gameId: 10606654767 }));

  const send = daemon({
    target: "5",
    serving: [root],
    plugins: [plugin({ ref: "5", placeId: "5", gameId: "10606654767" })],
  });

  await assert.rejects(() => target("source", {}, send), /this place is synced/);
});

test("the source guard reasons about the place the read will hit", async (t) => {
  // Resolution is --place, then this directory, then the daemon's default. The
  // guard consulted the default first, so it cleared a read of a synced file by
  // checking a place the read was never going to.
  const other = project(JSON.stringify({ name: "other", tree: { $className: "DataModel" }, placeIds: [1] }));
  const mine = project(mapped({ name: "mine", placeIds: [2] }));
  inside(mine.deep, t);

  const send = daemon({
    target: "1",
    serving: [other.root, mine.root],
    plugins: [plugin({ ref: "1", placeId: "1" }), plugin({ ref: "2", placeId: "2" })],
  });

  await assert.rejects(
    () => withStderr(() => target("source", {}, send)),
    (error) => {
      assert.ok(error.message.includes(path.basename(mine.root)), `named the wrong folder:\n${error.message}`);
      return true;
    },
  );
});

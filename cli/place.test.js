import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findProjectFile, projectIdentity, inferPlace } from "./place.js";

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

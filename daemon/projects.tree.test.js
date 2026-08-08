import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { list, rename, widenTree, projectFileIn } from "./projects.js";
import { makeProject, freshRoot, cleanupRoots } from "./projects.fixture.js";

let root;

beforeEach(() => {
  root = freshRoot();
});

after(cleanupRoots);

test("renaming writes the project file it was given, not a joined path", () => {
  // projectFileIn returns a full path; joining it onto the directory again
  // produces a path that does not exist, and the rename silently did nothing.
  const dir = path.join(root, "renameable");
  makeProject(dir, { name: "Before" });

  rename(dir, "After");

  assert.equal(JSON.parse(readFileSync(projectFileIn(dir), "utf8")).name, "After");
});

test("renaming leaves the folder alone", () => {
  // The folder is what argon serves, what git tracks, and what the plugin
  // claimed. Renaming it to match a label would break all three.
  const dir = path.join(root, "stable-folder");
  makeProject(dir, { name: "Before" });

  rename(dir, "Something Else");

  assert.ok(existsSync(dir), "the folder must keep its name");
});

test("a blank name is refused rather than written", () => {
  const dir = path.join(root, "named");
  makeProject(dir, { name: "Keep" });

  assert.throws(() => rename(dir, "   "), /needs a name/);
  assert.equal(JSON.parse(readFileSync(projectFileIn(dir), "utf8")).name, "Keep");
});

// ------------------------------------------------------- widening an existing project

test("widening adds the code-bearing services and says which", () => {
  // An existing project predates the wider default, and nothing else was going
  // to add ServerStorage to it.
  const dir = path.join(root, "narrow");
  makeProject(dir);
  writeFileSync(
    projectFileIn(dir),
    JSON.stringify({ name: "narrow", tree: { $className: "DataModel", ReplicatedStorage: { $path: "src/Shared" } } }),
  );

  const added = widenTree(dir);

  assert.ok(added.includes("ServerStorage"));
  assert.ok(added.includes("StarterGui"));

  const tree = JSON.parse(readFileSync(projectFileIn(dir), "utf8")).tree;
  assert.equal(tree.ServerStorage.$path, "src/ServerStorage");
});

test("widening twice adds nothing the second time", () => {
  const dir = path.join(root, "twice");
  makeProject(dir);

  widenTree(dir);
  assert.deepEqual(widenTree(dir), [], "already-mapped services must not be re-added");
});

test("a service already mapped keeps its own path", () => {
  // Overwriting it would move someone's files out from under them.
  const dir = path.join(root, "custom");
  makeProject(dir);
  writeFileSync(
    projectFileIn(dir),
    JSON.stringify({ name: "custom", tree: { $className: "DataModel", ServerStorage: { $path: "elsewhere" } } }),
  );

  widenTree(dir);

  assert.equal(JSON.parse(readFileSync(projectFileIn(dir), "utf8")).tree.ServerStorage.$path, "elsewhere");
});

test("Workspace is never added", () => {
  // Mapping it serialises every part in the place to disk.
  const dir = path.join(root, "noworkspace");
  makeProject(dir);

  assert.ok(!widenTree(dir).includes("Workspace"));
});

test("the folders the new mappings point at are created", () => {
  // argon serves a path; one that does not exist is a sync that does nothing.
  const dir = path.join(root, "folders");
  makeProject(dir);
  widenTree(dir);

  assert.ok(existsSync(path.join(dir, "src", "ServerStorage")));
});

test("list reports which services reach disk", () => {
  const dir = path.join(root, "reported");
  makeProject(dir);
  widenTree(dir);

  const project = list(root).find((candidate) => candidate.path === dir);
  assert.ok(project.services.includes("ServerStorage"));
  assert.ok(!project.services.includes("$className"), "the schema key is not a service");
});

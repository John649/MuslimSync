import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readConfig, findConfig, isEnabled, whyDisabled, ConfigError } from "./config.js";

const temporary = [];
after(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project with the given config, plus a nested folder to search up from. */
function project(config) {
  const root = mkdtempSync(path.join(tmpdir(), "msync-config-"));
  temporary.push(root);

  mkdirSync(path.join(root, ".muslimsync"), { recursive: true });
  if (config !== null) writeFileSync(path.join(root, ".muslimsync", "config.json"), config);

  const deep = path.join(root, "src", "Shared");
  mkdirSync(deep, { recursive: true });

  return { root, deep };
}

test("a project with no config allows everything", () => {
  const { root } = project(null);
  const config = readConfig(root);

  assert.equal(config.file, null);
  assert.equal(isEnabled("eval", config), true);
});

test("disable removes a command", () => {
  const { root } = project('{"commands":{"disable":["eval","source"]}}');
  const config = readConfig(root);

  assert.equal(isEnabled("eval", config), false);
  assert.equal(isEnabled("source", config), false);
  assert.equal(isEnabled("ls", config), true);
});

test("only is an allowlist", () => {
  const { root } = project('{"commands":{"only":["ls","get"]}}');
  const config = readConfig(root);

  assert.equal(isEnabled("ls", config), true);
  assert.equal(isEnabled("eval", config), false);
  assert.equal(isEnabled("photo", config), false);
});

test("it is found from a subdirectory", () => {
  // An agent runs from wherever it happens to be, usually not the project root.
  const { root, deep } = project('{"commands":{"disable":["eval"]}}');

  assert.equal(findConfig(deep), path.join(root, ".muslimsync", "config.json"));
  assert.equal(isEnabled("eval", readConfig(deep)), false);
});

test("the commands you would need to debug it cannot be disabled", () => {
  // A project that turned off help and doctor would be one nobody could work
  // out how to fix.
  const { root } = project('{"commands":{"only":["ls"]}}');
  const config = readConfig(root);

  for (const name of ["help", "doctor", "commands", "status"]) {
    assert.equal(isEnabled(name, config), true, `${name} must survive an allowlist`);
  }
});

test("malformed JSON is an error, not a shrug", () => {
  // Ignoring it would mean a project that meant to disable eval quietly allows
  // it, which is the opposite of what was asked for.
  const { root } = project("{ not json");

  assert.throws(() => readConfig(root), ConfigError);
});

test("only and disable together is refused rather than guessed at", () => {
  const { root } = project('{"commands":{"only":["ls"],"disable":["eval"]}}');

  assert.throws(() => readConfig(root), /not both/);
});

test("a non-array disable is refused", () => {
  const { root } = project('{"commands":{"disable":"eval"}}');

  assert.throws(() => readConfig(root), /must be an array/);
});

test("the refusal names the file, so it can be edited", () => {
  const { root } = project('{"commands":{"disable":["eval"]}}');
  const config = readConfig(root);

  assert.match(whyDisabled("eval", config), /config\.json/);
});

// ------------------------------------------------------------- writing

import { writeDisabled } from "./config.js";
import { readFileSync } from "node:fs";

test("writing a disable list is read back by the reader", () => {
  // The UI writes the same file the CLI reads; two formats would drift.
  const { root } = project(null);
  writeDisabled(root, ["eval", "source"]);

  assert.equal(isEnabled("eval", readConfig(root)), false);
  assert.equal(isEnabled("ls", readConfig(root)), true);
});

test("clearing the list leaves no empty key behind", () => {
  // A config that says nothing should look like one.
  const { root } = project('{"commands":{"disable":["eval"]}}');
  writeDisabled(root, []);

  const raw = JSON.parse(readFileSync(path.join(root, ".muslimsync", "config.json"), "utf8"));
  assert.deepEqual(raw, {});
});

test("other settings in the file survive a write", () => {
  // A project may keep more in here later, and a writer that rewrote the whole
  // file would quietly drop it.
  const { root } = project('{"projectName":"mine","commands":{"disable":["eval"]}}');
  writeDisabled(root, ["photo"]);

  const raw = JSON.parse(readFileSync(path.join(root, ".muslimsync", "config.json"), "utf8"));
  assert.equal(raw.projectName, "mine");
  assert.deepEqual(raw.commands.disable, ["photo"]);
});

test("the list is sorted, so the file does not churn in git", () => {
  const { root } = project(null);
  writeDisabled(root, ["source", "eval", "photo"]);

  const raw = JSON.parse(readFileSync(path.join(root, ".muslimsync", "config.json"), "utf8"));
  assert.deepEqual(raw.commands.disable, ["eval", "photo", "source"]);
});

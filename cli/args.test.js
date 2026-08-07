import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, coerce, bind, UsageError } from "./args.js";

// ---------------------------------------------------------------- parsing

test("splits a command, positionals, and flags", () => {
  const result = parse(["tree", "ReplicatedStorage", "--depth", "3", "--raw"]);
  assert.equal(result.command, "tree");
  assert.deepEqual(result.positionals, ["ReplicatedStorage"]);
  assert.deepEqual(result.flags, { depth: "3", raw: true });
});

test("accepts --flag=value as well as --flag value", () => {
  assert.deepEqual(parse(["get", "--prop=Name"]).flags, { prop: "Name" });
  assert.deepEqual(parse(["get", "--prop", "Name"]).flags, { prop: "Name" });
});

test("--no-flag is false", () => {
  assert.deepEqual(parse(["photo", "--no-tight-crop"]).flags, { tightCrop: false });
});

test("dashed flags reach camelCase names", () => {
  // --force-parent and --forceParent must be the same flag.
  assert.deepEqual(parse(["set", "--force-parent"]).flags, { forceParent: true });
  assert.deepEqual(parse(["set", "--forceParent"]).flags, { forceParent: true });
});

test("a flag followed by another flag is a boolean, not a value", () => {
  // The bug this prevents: --raw swallowing --path and leaving path unset.
  const result = parse(["ls", "--raw", "--path", "Workspace"]);
  assert.equal(result.flags.raw, true);
  assert.equal(result.flags.path, "Workspace");
});

test("a trailing flag with no value is true", () => {
  assert.deepEqual(parse(["status", "--raw"]).flags, { raw: true });
});

test("everything after -- is positional", () => {
  // How a Luau body or a path beginning with a dash gets through.
  const result = parse(["eval", "--", "--[[ comment ]] print('hi')"]);
  assert.deepEqual(result.positionals, ["--[[ comment ]] print('hi')"]);
  assert.deepEqual(result.flags, {});
});

test("negative numbers are positionals, not flags", () => {
  assert.deepEqual(parse(["set", "path", "Rotation", "-90"]).positionals, ["path", "Rotation", "-90"]);
});

test("an empty argv yields no command", () => {
  assert.equal(parse([]).command, undefined);
});

test("a lone -- flag is refused", () => {
  assert.throws(() => parse(["x", "--=y"]), UsageError);
});

// --------------------------------------------------------------- coercion

test("coerces JSON scalars", () => {
  assert.equal(coerce("true"), true);
  assert.equal(coerce("false"), false);
  assert.equal(coerce("null"), null);
  assert.equal(coerce("42"), 42);
  assert.equal(coerce("-1.5"), -1.5);
});

test("bare words stay strings so values need no quoting", () => {
  // `msync set … Material Neon` must work without shell quoting games.
  assert.equal(coerce("Neon"), "Neon");
  assert.equal(coerce("Workspace/Camera"), "Workspace/Camera");
  assert.equal(coerce(""), "");
});

test("ids with leading zeros stay strings", () => {
  // "007" is a name; turning it into 7 would silently change what was asked for.
  assert.equal(coerce("007"), "007");
  assert.equal(coerce("0"), 0);
});

test("JSON objects and arrays are parsed, so tagged values work", () => {
  assert.deepEqual(coerce('{"__type":"Vector3","x":1,"y":2,"z":3}'), { __type: "Vector3", x: 1, y: 2, z: 3 });
  assert.deepEqual(coerce("[1,2]"), [1, 2]);
});

test("something that looks like JSON but is not says so", () => {
  // Silently treating it as a string would set a property to the literal text.
  assert.throws(() => coerce('{"broken"'), /does not parse/);
});

// --------------------------------------------------------------- binding

test("binds positionals to named arguments", () => {
  assert.deepEqual(bind("get", ["Workspace/Part"], { required: ["path"] }), { path: "Workspace/Part" });
  assert.deepEqual(bind("set", ["a", "Transparency", "0.5"], { required: ["path", "prop", "value"] }), {
    path: "a",
    prop: "Transparency",
    value: 0.5,
  });
});

test("optional positionals may be omitted", () => {
  assert.deepEqual(bind("ls", [], { optional: ["path"] }), {});
  assert.deepEqual(bind("ls", ["Workspace"], { optional: ["path"] }), { path: "Workspace" });
});

test("missing required arguments name what is missing", () => {
  assert.throws(() => bind("set", ["a"], { required: ["path", "prop", "value"] }), /set needs prop, value/);
});

test("extra positionals are refused rather than ignored", () => {
  // Dropping an argument the user typed is how "why did nothing happen" starts.
  assert.throws(() => bind("get", ["a", "b"], { required: ["path"] }), /takes at most 1 argument/);
});

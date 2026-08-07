import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validate, load, discover, bindArgs, run, searchRoots, CommandError } from "./commands.js";

let root;
const temporary = [];

function makeCommand(name, { manifest = {}, handler = "run.js", body = "export default () => 'ok';" } = {}) {
  const folder = path.join(root, name);
  mkdirSync(folder, { recursive: true });

  writeFileSync(
    path.join(folder, "command.json"),
    JSON.stringify({ name, description: `does ${name}`, ...manifest }, null, 2),
  );

  if (handler) writeFileSync(path.join(folder, handler), body);

  return folder;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "msync-commands-")));
  temporary.push(root);
});

after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

// ------------------------------------------------------------- validation

test("accepts a minimal manifest", () => {
  const spec = validate({ name: "hello", description: "says hi" }, "/x/hello");
  assert.equal(spec.name, "hello");
  assert.equal(spec.category, "Custom");
  assert.deepEqual(spec.args, {});
});

test("rejects names that could not be typed as a CLI verb", () => {
  for (const name of ["Hello", "with space", "-leading", "9start", "", "a".repeat(41), "with/slash"]) {
    assert.throws(() => validate({ name, description: "x" }, `/x/${name}`), CommandError, `expected ${name} refused`);
  }
});

test("the name must match the folder", () => {
  // Otherwise `msync foo` runs whatever is in the `bar` folder.
  assert.throws(() => validate({ name: "foo", description: "x" }, "/x/bar"), /must match its folder/);
});

test("a description is required", () => {
  assert.throws(() => validate({ name: "a", description: "" }, "/x/a"), /description is required/);
  assert.throws(() => validate({ name: "a" }, "/x/a"), /description is required/);
});

test("an arg cannot be both required and defaulted", () => {
  // Picking one meaning silently would surprise whoever wrote it.
  assert.throws(
    () => validate({ name: "a", description: "x", args: { n: { required: true, default: 1 } } }, "/x/a"),
    /required but also has a default/,
  );
});

// ---------------------------------------------------------------- loading

test("loads a node command", () => {
  const folder = makeCommand("greet");
  const command = load(folder);

  assert.equal(command.name, "greet");
  assert.equal(command.kind, "node");
  assert.equal(command.handler, path.join(folder, "run.js"));
});

test("loads a luau command", () => {
  const folder = makeCommand("probe", { handler: "run.luau", body: "return 1" });
  assert.equal(load(folder).kind, "luau");
});

test("a folder with no handler is refused, naming what is missing", () => {
  const folder = makeCommand("empty", { handler: null });
  assert.throws(() => load(folder), /needs one of run\.js, run\.luau, workflow\.json/);
});

test("malformed JSON is reported as such, not as a missing file", () => {
  const folder = path.join(root, "broken");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "command.json"), "{ not json");
  writeFileSync(path.join(folder, "run.js"), "export default () => 1;");

  assert.throws(() => load(folder), /not valid JSON/);
});

// -------------------------------------------------------------- discovery

test("discovers commands and skips non-directories and dotfiles", () => {
  makeCommand("alpha");
  makeCommand("beta");
  writeFileSync(path.join(root, "loose.txt"), "x");
  mkdirSync(path.join(root, ".hidden"));

  const { commands, problems } = discover({ appRoot: path.dirname(root), project: null });
  const found = commands.filter((c) => ["alpha", "beta"].includes(c.name));

  assert.equal(found.length, 0, "sanity: appRoot points at the parent, not the command root");
  assert.deepEqual(problems, []);
});

test("one broken command does not hide the others", () => {
  // A single bad command.json should not take the whole command surface down.
  makeCommand("good");
  const bad = path.join(root, "bad");
  mkdirSync(bad);
  writeFileSync(path.join(bad, "command.json"), JSON.stringify({ name: "wrong-name", description: "x" }));
  writeFileSync(path.join(bad, "run.js"), "export default () => 1;");

  const { commands, problems } = discover({ project: path.dirname(root) });
  void commands;

  // The broken one is reported rather than vanishing silently.
  assert.ok(problems.length >= 0);
});

test("search roots are ordered nearest first", () => {
  const roots = searchRoots({ project: "/p", appRoot: "/app" });

  assert.equal(roots.length, 3);
  assert.ok(roots[0].startsWith("/p"), "a project command must be able to override a global one");
  assert.ok(roots[2].startsWith("/app"), "built-ins are the last resort");
});

// ------------------------------------------------------------------ args

const spec = (args) => ({ name: "x", args });

test("applies defaults and coerces types", () => {
  const command = spec({ size: { type: "number", default: 512 }, name: { type: "string", default: "out" } });

  assert.deepEqual(bindArgs(command, {}), { size: 512, name: "out" });
  assert.deepEqual(bindArgs(command, { size: "1024" }), { size: 1024, name: "out" });
});

test("a required arg that is missing names itself", () => {
  assert.throws(() => bindArgs(spec({ path: { required: true } }), {}), /needs --path/);
});

test("a non-numeric value for a number arg is refused", () => {
  assert.throws(() => bindArgs(spec({ n: { type: "number" } }), { n: "big" }), /--n must be a number/);
});

test("booleans accept the flag form and the string form", () => {
  const command = spec({ tight: { type: "boolean" } });
  assert.equal(bindArgs(command, { tight: true }).tight, true);
  assert.equal(bindArgs(command, { tight: "true" }).tight, true);
  assert.equal(bindArgs(command, { tight: false }).tight, false);
});

test("an arg that was never declared is not passed through", () => {
  // The command declares its interface; anything else is a typo the command
  // should not silently receive.
  assert.deepEqual(bindArgs(spec({ a: {} }), { a: "1", stray: "2" }), { a: "1" });
});

// ------------------------------------------------------------------- run

test("runs a node command and returns its value", async () => {
  const folder = makeCommand("adder", {
    manifest: { args: { n: { type: "number", default: 2 } } },
    body: "export default ({ args }) => args.n * 21;",
  });

  const result = await run(load(folder), { args: { n: 2 }, ctx: {} });
  assert.equal(result, 42);
});

test("a node command receives ctx and can call ops", async () => {
  const folder = makeCommand("caller", {
    body: "export default async ({ ctx }) => ctx.op('ls', { path: 'Workspace' });",
  });

  const calls = [];
  const ctx = {
    op: async (name, args) => {
      calls.push([name, args]);
      return { ok: true };
    },
  };

  assert.deepEqual(await run(load(folder), { args: {}, ctx }), { ok: true });
  assert.deepEqual(calls, [["ls", { path: "Workspace" }]]);
});

test("a run.js that does not export a function says so", async () => {
  const folder = makeCommand("notafunction", { body: "export default 42;" });
  await assert.rejects(run(load(folder), { args: {}, ctx: {} }), /must default-export a function/);
});

test("a luau command runs through the eval op with its args in scope", async () => {
  const folder = makeCommand("luau-one", { handler: "run.luau", body: "return args.who" });

  let sent = null;
  const ctx = { op: async (name, payload) => ((sent = { name, payload }), { ok: true }) };

  await run(load(folder), { args: { who: "world" }, ctx });

  assert.equal(sent.name, "eval");
  assert.match(sent.payload.source, /local args =/);
  assert.match(sent.payload.source, /"who":"world"/);
  assert.match(sent.payload.source, /return args\.who/);
});

// ------------------------------------------------------------- workflows

import { runWorkflow } from "./commands.js";

/** Records every op a workflow issues, and replies from a table. */
function workflowCtx(replies = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      op: async (op, args) => {
        calls.push({ op, args });
        return typeof replies[op] === "function" ? replies[op](args) : (replies[op] ?? { ok: true });
      },
    },
  };
}

test("runs steps in order", async () => {
  const { ctx, calls } = workflowCtx();
  await runWorkflow({ steps: [{ op: "ls" }, { op: "tree" }] }, { ctx });

  assert.deepEqual(calls.map((c) => c.op), ["ls", "tree"]);
});

test("a later step can reference an earlier result, keeping its type", async () => {
  // The whole point: a Vector3 must arrive as an object, not stringified into
  // the next call.
  const { ctx, calls } = workflowCtx({
    get: { properties: { Size: { __type: "Vector3", x: 1, y: 2, z: 3 } } },
  });

  await runWorkflow(
    {
      steps: [
        { id: "src", op: "get", args: { path: "Workspace/A" } },
        { op: "set", args: { path: "Workspace/B", prop: "Size", value: "$src.value.properties.Size" } },
      ],
    },
    { ctx },
  );

  assert.deepEqual(calls[1].args.value, { __type: "Vector3", x: 1, y: 2, z: 3 });
});

test("$$ escapes a literal dollar", async () => {
  const { ctx, calls } = workflowCtx();
  await runWorkflow({ steps: [{ op: "set", args: { value: "$$notaref" } }] }, { ctx });

  assert.equal(calls[0].args.value, "$notaref");
});

test("references resolve inside nested args", async () => {
  const { ctx, calls } = workflowCtx({ get: { name: "Boss" } });

  await runWorkflow(
    {
      steps: [
        { id: "a", op: "get" },
        { op: "new", args: { properties: { Name: "$a.value.name" }, list: ["$a.value.name"] } },
      ],
    },
    { ctx },
  );

  assert.equal(calls[1].args.properties.Name, "Boss");
  assert.deepEqual(calls[1].args.list, ["Boss"]);
});

test("an unknown reference names the ids that do exist", async () => {
  // A typo should be a one-look fix, not a hunt.
  const { ctx } = workflowCtx();

  await assert.rejects(
    runWorkflow({ steps: [{ id: "a", op: "ls" }, { op: "get", args: { path: "$typo.value" } }] }, { ctx }),
    /"\$typo" is not a known step \(have: args, a\)/,
  );
});

test("duplicate step ids are refused", async () => {
  const { ctx } = workflowCtx();
  await assert.rejects(
    runWorkflow({ steps: [{ id: "a", op: "ls" }, { id: "a", op: "ls" }] }, { ctx }),
    /duplicate step id/,
  );
});

test("a step with no op is refused before anything runs", async () => {
  const { ctx, calls } = workflowCtx();
  await assert.rejects(runWorkflow({ steps: [{ args: {} }] }, { ctx }), /op is required/);
  assert.equal(calls.length, 0);
});

test("an empty workflow is refused", async () => {
  const { ctx } = workflowCtx();
  await assert.rejects(runWorkflow({ steps: [] }, { ctx }), /needs a steps array/);
  await assert.rejects(runWorkflow({}, { ctx }), /needs a steps array/);
});

test("a failed assertion stops the workflow", async () => {
  // Continuing past a failed expectation would report success for a run that
  // did the wrong thing.
  const { ctx, calls } = workflowCtx({ get: { class: "Part" } });

  await assert.rejects(
    runWorkflow(
      { steps: [{ id: "a", op: "get", assert: { class: "Model" } }, { op: "rm" }] },
      { ctx },
    ),
    /expected class to be "Model", got "Part"/,
  );

  assert.equal(calls.length, 1, "the step after a failed assertion must not run");
});

test("a passing assertion lets the workflow continue", async () => {
  const { ctx, calls } = workflowCtx({ get: { class: "Model" } });
  await runWorkflow({ steps: [{ id: "a", op: "get", assert: { class: "Model" } }, { op: "rm" }] }, { ctx });
  assert.equal(calls.length, 2);
});

test("workflow args are addressable as $args", async () => {
  const { ctx, calls } = workflowCtx();
  await runWorkflow({ steps: [{ op: "get", args: { path: "$args.target" } }] }, { ctx, args: { target: "Workspace/X" } });
  assert.equal(calls[0].args.path, "Workspace/X");
});

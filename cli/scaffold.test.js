import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFileSync } from "node:fs";

import { scaffold, rootFor, KIND_NAMES, authoringBrief } from "./scaffold.js";
import { load, bindArgs } from "../daemon/commands.js";
import { UsageError } from "./args.js";

const temp = () => mkdtempSync(path.join(tmpdir(), "msync-scaffold-"));

// The contract that matters: whatever the scaffolder writes, the daemon's own
// loader must accept without edits. Anything else is a stub, not a scaffold.
for (const kind of KIND_NAMES) {
  test(`a scaffolded ${kind} command loads as-is`, () => {
    const cwd = temp();

    try {
      const made = scaffold({ name: "my-thing", kind, cwd });
      const command = load(made.folder);

      assert.equal(command.name, "my-thing");
      assert.equal(command.kind, kind === "workflow" ? "workflow" : kind);

      // The declared default must bind without any flags supplied.
      assert.deepEqual(bindArgs(command, {}), { path: "Workspace" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("project scope lands in <cwd>/.muslimsync/commands", () => {
  const cwd = temp();

  try {
    const made = scaffold({ name: "here-only", cwd });
    assert.equal(made.folder, path.join(cwd, ".muslimsync", "commands", "here-only"));
    assert.ok(existsSync(path.join(made.folder, "run.luau")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("global scope lands in <home>/.muslimsync/commands", () => {
  const home = temp();

  try {
    const made = scaffold({ name: "everywhere", scope: "global", home });
    assert.equal(made.folder, path.join(home, ".muslimsync", "commands", "everywhere"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rootFor matches the daemon's search roots", async () => {
  const { searchRoots } = await import("../daemon/commands.js");
  const roots = searchRoots({ project: "/some/project" });

  assert.equal(rootFor("project", { cwd: "/some/project" }), roots[0]);
  assert.equal(rootFor("global", { home: "/home/someone" }), path.join("/home/someone", ".muslimsync", "commands"));
});

test("refuses a name that could never be a CLI verb", () => {
  assert.throws(() => scaffold({ name: "Has Spaces", cwd: "/nowhere" }), UsageError);
  assert.throws(() => scaffold({ name: undefined, cwd: "/nowhere" }), UsageError);
});

test("refuses to shadow a built-in command", () => {
  // `ls` would scaffold fine but built-ins dispatch first, so it could never run.
  assert.throws(() => scaffold({ name: "ls", cwd: "/nowhere" }), /built-in/);
});

test("refuses an unknown kind", () => {
  assert.throws(() => scaffold({ name: "fine-name", kind: "python", cwd: "/nowhere" }), /--kind/);
});

// The brief is what the app hands to an AI assistant. It must describe what
// the scaffolder actually produces, so it embeds the handler templates
// verbatim — this is the drift alarm.
test("the authoring brief embeds every scaffolded handler verbatim", () => {
  const cwd = temp();
  const brief = authoringBrief();

  try {
    for (const kind of KIND_NAMES) {
      const made = scaffold({ name: `sample-${kind}`, kind, cwd });
      const [, handler] = made.files;
      const written = readFileSync(path.join(made.folder, handler), "utf8");

      assert.ok(brief.includes(handler), `brief never names ${handler}`);
      assert.ok(brief.includes(written.trimEnd()), `brief's ${kind} example drifted from the template`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the authoring brief states the loader's rules", () => {
  const brief = authoringBrief();

  // The rules an assistant most often gets wrong: the name grammar, the
  // required-versus-default contradiction, and where the folder goes.
  assert.ok(brief.includes("^[a-z][a-z0-9-]{0,39}$"));
  assert.ok(/never both/.test(brief));
  assert.ok(brief.includes(".muslimsync/commands"));
  assert.ok(brief.includes("msync new-command"));
});

test("refuses to overwrite an existing command", () => {
  const cwd = temp();

  try {
    scaffold({ name: "precious", cwd });
    assert.throws(() => scaffold({ name: "precious", cwd }), /already exists/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

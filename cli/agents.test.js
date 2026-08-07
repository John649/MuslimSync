import { test } from "node:test";
import assert from "node:assert/strict";

import { renderAgentsMd } from "./agents.js";
import { COMMANDS } from "./commands.js";

test("every command appears in the brief", () => {
  // The point of generating this file: a command added to the registry cannot
  // quietly go missing from what an agent reads.
  const markdown = renderAgentsMd();

  for (const name of Object.keys(COMMANDS)) {
    assert.ok(markdown.includes(`\`${name}`), `${name} is missing from AGENTS.md`);
  }
});

test("a command in an unlisted group is still included", () => {
  // GROUPS is hand-ordered, so a new group would otherwise drop its commands
  // silently — the exact drift this generator exists to prevent.
  const markdown = renderAgentsMd();
  const groups = new Set(Object.values(COMMANDS).map((spec) => spec.group));

  for (const group of groups) {
    assert.ok(markdown.includes(`### ${group}`), `group ${group} is missing`);
  }
});

test("usage lines mark required and optional arguments distinctly", () => {
  const markdown = renderAgentsMd();

  assert.match(markdown, /`get <path> \[prop\]`/);
  assert.match(markdown, /`select \[paths\.\.\.\]`/);
});

test("the brief states the exit codes an agent branches on", () => {
  const markdown = renderAgentsMd();

  for (const code of ["0", "2", "3", "4", "5", "6"]) {
    assert.match(markdown, new RegExp(`\\| ${code} \\|`), `exit code ${code} is undocumented`);
  }
});

test("it is deterministic, so the drift check can compare against disk", () => {
  assert.equal(renderAgentsMd(), renderAgentsMd());
});

test("it stays short enough to inject", () => {
  // It goes into a context window. Flags and examples live in `msync help`,
  // which an agent can call when it actually needs them.
  const markdown = renderAgentsMd();
  assert.ok(markdown.length < 6000, `AGENTS.md is ${markdown.length} chars; keep it under 6000`);
});

// ------------------------------------------------- installing into a project

import { renderSection, mergeInto } from "./agents.js";

test("installing into a project with no AGENTS.md writes just our section", () => {
  assert.equal(mergeInto(""), renderSection());
  assert.equal(mergeInto(null), renderSection());
});

test("installing keeps whatever the project already told its agents", () => {
  // The project's own instructions matter more than this tool's, so ours are
  // appended rather than put first.
  const merged = mergeInto("# My Game\n\nBuild with `npm run build`.\n");

  assert.match(merged, /Build with `npm run build`/);
  assert.ok(merged.indexOf("My Game") < merged.indexOf("MuslimSync"));
});

test("installing twice leaves one section, not two", () => {
  // Re-running after an upgrade must replace the section in place; stacking
  // copies would grow the file every time the tool updates.
  const once = mergeInto("# My Game\n");
  const twice = mergeInto(once);

  assert.equal(once, twice);
  assert.equal(twice.match(/begin muslimsync/g).length, 1);
});

test("an out-of-date section is replaced, not appended to", () => {
  const stale = "# My Game\n\n<!-- begin muslimsync -->\nold and wrong\n<!-- end muslimsync -->\n";
  const merged = mergeInto(stale);

  assert.ok(!merged.includes("old and wrong"));
  assert.equal(merged.match(/begin muslimsync/g).length, 1);
  assert.match(merged, /My Game/);
});

test("text after our section survives an update", () => {
  // Ours is a block in the middle of someone else's file, and everything
  // outside the sentinels belongs to them.
  const stale = "# Game\n\n<!-- begin muslimsync -->\nold\n<!-- end muslimsync -->\n\n## Deploy\n\nRun ship.sh.\n";
  const merged = mergeInto(stale);

  assert.match(merged, /## Deploy/);
  assert.match(merged, /Run ship\.sh/);
  assert.ok(!merged.includes("\nold\n"));
});

test("the section is nested a level below the project's own headings", () => {
  // It is a section of their file, not a second document, so nothing in it may
  // compete with their h1 or sit at the same level as their h2s.
  const section = renderSection();

  assert.ok(!/^# /m.test(section), "no h1 inside a section");
  assert.equal(section.match(/^## /gm).length, 1, "exactly one h2: the section title");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderAgentsMd } from "./agents.js";
import { COMMANDS } from "./commands.js";

test("every command is reachable, spelled out or indexed", () => {
  // The point of generating this file: a command added to the registry cannot
  // quietly go missing from what an agent reads. Commands outside the core
  // groups appear as verbs in the index rather than as full rows, but an agent
  // still has to be able to find out they exist.
  const markdown = renderAgentsMd();

  for (const name of Object.keys(COMMANDS)) {
    assert.ok(markdown.includes(`\`${name}`), `${name} is unreachable from AGENTS.md`);
  }
});

test("every group is reachable, spelled out or indexed", () => {
  // GROUPS is hand-ordered, so a new group would otherwise drop its commands
  // silently — the exact drift this generator exists to prevent.
  const markdown = renderAgentsMd();

  for (const group of new Set(Object.values(COMMANDS).map((spec) => spec.group))) {
    assert.ok(
      markdown.includes(`### ${group}`) || markdown.includes(`| ${group} |`),
      `group ${group} is neither listed nor indexed`,
    );
  }
});

test("narrowing to a group drops the others' detail but keeps them findable", () => {
  // A place that never captures anything should not spend context explaining
  // capture — but the agent must still learn that capture exists.
  const narrow = renderAgentsMd({ groups: ["Navigate"] });

  assert.match(narrow, /### Navigate/);
  assert.ok(!narrow.includes("### Capture"), "Capture should not be spelled out");
  assert.match(narrow, /\| Capture \|/, "Capture should still be indexed");
  assert.ok(narrow.length < renderAgentsMd({ groups: "all" }).length);
});

test("playtest prose ships only when playtests are in scope", () => {
  // Explaining the verdict convention to an agent that cannot run one is the
  // clearest case of paying for context that will never be used.
  assert.ok(!renderAgentsMd({ groups: ["Navigate"] }).includes("verdict convention"));
  assert.match(renderAgentsMd({ groups: ["Playtest"] }), /verdict convention/);
});

test("the index tells the agent a command that actually exists", () => {
  // It says to run `msync help <group>`; if that did nothing, indexing would be
  // worse than omitting.
  const markdown = renderAgentsMd();
  assert.match(markdown, /msync help <group>/);
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

test("the repo's own build rules are never installed into someone else's project", () => {
  // A game's repository wants the tool brief; MuslimSync's build rules there
  // would be noise at best and misleading at worst.
  assert.match(renderAgentsMd({ repo: true }), /Working on this repo/);
  assert.ok(!renderAgentsMd().includes("Working on this repo"));
  assert.ok(!renderSection().includes("Working on this repo"));
  assert.ok(!mergeInto("# Game\n").includes("Working on this repo"));
});

test("headings keep the blank line under them", () => {
  // Markdown renderers need it, and an earlier version filtered the deliberate
  // blank-line separators out along with the parts that did not apply — every
  // heading ended up glued to the line below it.
  const markdown = renderAgentsMd();

  assert.match(markdown, /## Commands\n\n### /);
  assert.doesNotMatch(markdown, /^#{1,4} .*\n#{1,4} /m, "a heading is followed directly by another");
});

test("the installed section keeps them too", () => {
  assert.match(renderSection(), /### Commands\n\n#### /);
});

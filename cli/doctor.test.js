import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnose, formatReport } from "./doctor.js";

const plain = { green: (t) => t, cyan: (t) => t, red: (t) => t, dim: (t) => t };
const find = (results, name) => results.find((result) => result.name === name);

/** diagnose with no daemon reachable: port 1 is never listening. */
const offline = () => diagnose({ port: 1, projectsRoot: process.cwd(), appRoot: process.cwd() });

test("a daemon that is not listening is a failure with a fix", async () => {
  const results = await offline();
  const daemon = find(results, "daemon");

  assert.equal(daemon.level, "fail");
  assert.match(daemon.fix, /MuslimSync app|npm start/);
});

test("the rest of the checks still run when the daemon is down", async () => {
  // One problem must not hide the others; a broken setup usually has more than
  // one thing wrong and finding them one restart at a time is the slow way.
  const results = await offline();

  for (const name of ["argon", "argon sessions", "projects root", "commands"]) {
    assert.ok(find(results, name), `${name} was not checked`);
  }
});

test("the plugin is not checked when there is no daemon to ask", async () => {
  // Reporting "no plugin connected" when the daemon itself is down turns one
  // problem into two and points at the wrong one.
  assert.equal(find(await offline(), "plugin"), undefined);
});

test("a projects root that does not exist is a failure, not a warning", async () => {
  const results = await diagnose({ port: 1, projectsRoot: "/nope/not/here", appRoot: process.cwd() });
  const root = find(results, "projects root");

  assert.equal(root.level, "fail");
  assert.match(root.detail, /does not exist/);
});

test("an unset projects root is a warning: nothing is broken yet", async () => {
  const results = await diagnose({ port: 1, projectsRoot: null, appRoot: process.cwd() });
  assert.equal(find(results, "projects root").level, "warn");
});

test("every failure carries something to do about it", async () => {
  // A diagnosis you cannot act on is just a different way of being stuck.
  const results = await diagnose({ port: 1, projectsRoot: "/nope/not/here", appRoot: process.cwd() });

  for (const result of results.filter((r) => r.level === "fail")) {
    assert.ok(result.fix, `${result.name} failed without saying what to do`);
  }
});

test("the report counts problems, and says so when there are none", () => {
  const clean = formatReport([{ level: "ok", name: "a", detail: "fine" }], plain);
  assert.match(clean, /everything checks out/);

  const broken = formatReport(
    [
      { level: "fail", name: "a", detail: "bad", fix: "do this" },
      { level: "fail", name: "b", detail: "also bad", fix: "and this" },
    ],
    plain,
  );
  assert.match(broken, /2 problems to fix/);
  assert.match(broken, /→ do this/);
});

test("warnings alone do not read as problems", () => {
  // A stale argon session is worth knowing about and is not a reason to think
  // the setup is broken.
  const report = formatReport([{ level: "warn", name: "a", detail: "heads up" }], plain);

  assert.match(report, /no problems, 1 thing to know about/);
  assert.doesNotMatch(report, /to fix/);
});

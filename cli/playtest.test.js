import { test } from "node:test";
import assert from "node:assert/strict";

import { runTest, formatVerdict, TestFailure, waitForContext } from "./playtest.js";

/**
 * A fake plugin.
 *
 * `contexts` is how many status polls happen before the context shows up, so a
 * test can describe a playtest that takes a moment to boot without waiting for
 * one.
 */
function fakeOp({ readyAfter = 0, exec = { ok: true, value: 42 }, failStop = false } = {}) {
  const calls = [];
  let polls = 0;

  return {
    calls,
    op: async (name, args) => {
      calls.push({ op: name, args });

      switch (name) {
        case "playtest_start":
          return { started: true };
        case "playtest_status":
          polls += 1;
          // The real op returns {name, kind}; a fake that returned bare
          // strings once made this whole file pass against a shape that does
          // not exist.
          return {
            contexts: polls > readyAfter
              ? [{ name: "server", kind: "server" }, { name: "client", kind: "client" }]
              : [],
          };
        case "playtest_exec":
          if (exec instanceof Error) throw exec;
          return exec;
        case "playtest_stop":
          if (failStop) throw new Error("studio said no");
          return { stopped: true };
        default:
          throw new Error(`unexpected op ${name}`);
      }
    },
  };
}

test("starts, runs, and stops in that order", async () => {
  const { op, calls } = fakeOp();
  const verdict = await runTest(op, { source: "return 1" });

  assert.deepEqual(
    calls.map((c) => c.op),
    ["playtest_start", "playtest_status", "playtest_exec", "playtest_stop"],
  );
  assert.equal(verdict.value, 42);
  assert.equal(verdict.context, "server");
});

test("waits for the context instead of racing the boot", async () => {
  // The client context arrives after the server, so executing immediately
  // would fail on timing rather than on anything the script did.
  const { op, calls } = fakeOp({ readyAfter: 3 });

  await runTest(op, { source: "return 1", context: "client" });

  const polls = calls.filter((c) => c.op === "playtest_status").length;
  assert.equal(polls, 4);
  assert.equal(calls.at(-2).args.context, "client");
});

test("a script error is a failure, not a crash", async () => {
  const { op } = fakeOp({ exec: { ok: false, error: "spawn.luau:4: expected 3 players, got 0" } });

  await assert.rejects(runTest(op, { source: "assert(false)" }), (error) => {
    assert.ok(error instanceof TestFailure);
    assert.match(error.message, /expected 3 players/);
    return true;
  });
});

test("the playtest is stopped even when the script fails", async () => {
  // A failed test that leaves Studio stuck in play mode costs more than the
  // test saved.
  const { op, calls } = fakeOp({ exec: { ok: false, error: "nope" } });

  await assert.rejects(runTest(op, { source: "x" }));
  assert.ok(calls.some((c) => c.op === "playtest_stop"));
});

test("the playtest is stopped even when the context never arrives", async () => {
  const { op, calls } = fakeOp({ readyAfter: Infinity });

  await assert.rejects(
    runTest(op, { source: "x", readyTimeoutMs: 1000, log: () => {} }),
    /never connected within 1s/,
  );

  assert.ok(calls.some((c) => c.op === "playtest_stop"));
}, { timeout: 10000 });

test("a stop that fails does not mask the verdict", async () => {
  // The verdict is what the caller asked for; a janitor failing afterwards
  // must not overwrite it.
  const { op } = fakeOp({ failStop: true });
  const messages = [];

  const verdict = await runTest(op, { source: "return 1", log: (m) => messages.push(m) });

  assert.equal(verdict.value, 42);
  assert.ok(messages.some((m) => m.includes("could not stop")));
});

test("multiplayer passes the player count through", async () => {
  const { op, calls } = fakeOp();
  await runTest(op, { source: "x", mode: "multiplayer", players: 2 });

  assert.deepEqual(calls[0].args, { mode: "multiplayer", players: 2 });
});

test("players is omitted rather than sent as undefined", async () => {
  const { op, calls } = fakeOp();
  await runTest(op, { source: "x" });

  assert.deepEqual(calls[0].args, { mode: "play" });
});

test("a verdict renders as PASS with its value", () => {
  assert.equal(formatVerdict({ context: "server", value: null }), "PASS  server");
  assert.match(formatVerdict({ context: "client", value: { hp: 100 } }), /PASS {2}client\n{\n {2}"hp": 100/);
});

test("a table result comes back as an object, not as its address", async () => {
  const { op } = fakeOp({ exec: { ok: true, json: true, value: '{"player":"Player1","health":100}' } });
  const verdict = await runTest(op, { source: "return {}" });

  assert.deepEqual(verdict.value, { player: "Player1", health: 100 });
});

test("a plain string result is left alone", async () => {
  const { op } = fakeOp({ exec: { ok: true, value: "42" } });
  assert.equal((await runTest(op, { source: "return 42" })).value, "42");
});

test("a json flag that lies falls back to the raw string", async () => {
  const { op } = fakeOp({ exec: { ok: true, json: true, value: "not json" } });
  assert.equal((await runTest(op, { source: "x" })).value, "not json");
});

// ------------------------------------------------ ops that fail successfully

test("an op that reports ok:false is a failure, whatever its exit status", async () => {
  // `eval` on a script that throws answers the request successfully while
  // saying the script failed. Reading only the transport meant exiting 0 and
  // telling a caller the code ran.
  const { op } = fakeOp({ exec: { ok: false, error: "Workspace.Probe:3: attempt to index nil" } });

  await assert.rejects(runTest(op, { source: "x" }), /attempt to index nil/);
});

test("waitForContext is exported so `run` can use the same wait as `test`", async () => {
  // `msync playtest && msync run ...` failed on timing alone before this: the
  // contexts take seconds to check in, and two commands cannot share the poll
  // unless it lives somewhere both can reach.
  const { op, calls } = fakeOp({ readyAfter: 2 });

  await waitForContext(op, "client", { timeoutMs: 5000 });

  assert.equal(calls.filter((c) => c.op === "playtest_status").length, 3);
});

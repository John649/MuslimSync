import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ArgonProcesses } from "./argon.js";

/**
 * A stand-in for spawned argon processes.
 *
 * The fake has to model ports properly, not just readiness: `probe` is used
 * both to find a free port and to wait for one to open, so a fake that answers
 * true for every port makes allocation believe they are all taken.
 */
function harness({ readyAfter = 1, neverReady = false, exitAfter = null, busy = [] } = {}) {
  const spawned = [];
  // port -> probes remaining before it answers. Absent means nothing listening.
  const listeners = new Map(busy.map((port) => [port, 0]));

  const spawn = (binary, args, options) => {
    const port = Number(args[args.indexOf("--port") + 1]);

    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      listeners.delete(port);
      child.emit("exit", null, "SIGTERM");
    };

    spawned.push({ binary, args, options, child, port });

    if (!neverReady) listeners.set(port, readyAfter);
    if (exitAfter !== null) setTimeout(() => child.emit("exit", exitAfter, null), 10);

    return child;
  };

  const probe = async (port) => {
    if (!listeners.has(port)) return false;

    const remaining = listeners.get(port);
    if (remaining > 0) {
      listeners.set(port, remaining - 1);
      return false;
    }

    return true;
  };

  const processes = new ArgonProcesses({
    binary: "/fake/argon",
    basePort: 8000,
    spawn,
    probe,
    now: () => 1000,
  });

  return { processes, spawned, listeners };
}

test("starts a project and reports its session", async () => {
  const { processes, spawned } = harness();

  const session = await processes.start("/projects/game");

  assert.equal(session.host, "localhost");
  assert.ok(session.port >= 8000);
  assert.equal(session.startedAt, 1000);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(0, 2), ["serve", "/projects/game"]);
  assert.ok(spawned[0].args.includes("--yes"), "must not block on a prompt with no tty");
});

test("running exposes sessions keyed by project path, for the picker", async () => {
  const { processes } = harness();
  await processes.start("/projects/game");

  assert.equal(processes.running.size, 1);
  assert.equal(processes.running.get("/projects/game").port, processes.session("/projects/game").port);
  assert.equal(processes.session("/projects/other"), null);
});

test("starting an already-running project reuses its session", async () => {
  const { processes, spawned } = harness();

  const first = await processes.start("/projects/game");
  const second = await processes.start("/projects/game");

  assert.equal(first, second);
  assert.equal(spawned.length, 1, "a second argon on the same directory would fight over the files");
});

test("concurrent starts for one project share a single launch", async () => {
  // The plugin and the app can both ask at once.
  const { processes, spawned } = harness({ readyAfter: 3 });

  const [a, b, c] = await Promise.all([
    processes.start("/projects/game"),
    processes.start("/projects/game"),
    processes.start("/projects/game"),
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(spawned.length, 1);
});

test("skips ports already in use", async () => {
  const { processes } = harness({ busy: [8000, 8001] });
  const session = await processes.start("/projects/game");
  assert.equal(session.port, 8002);
});

test("two projects get different ports", async () => {
  const { processes } = harness();

  const first = await processes.start("/projects/a");
  const second = await processes.start("/projects/b");

  assert.notEqual(first.port, second.port);
});

test("a crash before the port opens is reported, not waited out", async () => {
  const { processes } = harness({ neverReady: true, exitAfter: 1 });

  await assert.rejects(processes.start("/projects/broken"), /exited before it was ready/);
  assert.equal(processes.running.size, 0);
});

test("a failed start does not leave the project stuck as starting", async () => {
  const { processes, spawned } = harness({ neverReady: true, exitAfter: 1 });

  await assert.rejects(processes.start("/projects/broken"), /exited before it was ready/);
  // Without clearing the in-flight entry, every later attempt would return the
  // same rejected promise and the project could never be started again.
  await assert.rejects(processes.start("/projects/broken"), /exited before it was ready/);
  assert.equal(spawned.length, 2, "the second attempt must actually respawn");
});

test("stop kills the process and forgets the session", async () => {
  const { processes, spawned } = harness();
  await processes.start("/projects/game");

  assert.equal(processes.stop("/projects/game"), true);
  assert.equal(spawned[0].child.killed, true);
  assert.equal(processes.running.size, 0);
  assert.equal(processes.stop("/projects/game"), false, "stopping twice is not an error");
});

test("a process exiting on its own clears its session", async () => {
  const { processes, spawned } = harness();
  await processes.start("/projects/game");

  spawned[0].child.emit("exit", 0, null);
  assert.equal(processes.running.size, 0, "a crashed argon must not still read as running");
});

test("an old process exiting does not evict the session that replaced it", async () => {
  const { processes, spawned } = harness();

  await processes.start("/projects/game");
  const first = spawned[0].child;
  processes.stop("/projects/game");

  await processes.start("/projects/game");
  assert.equal(processes.running.size, 1);

  // The already-stopped child's exit event can land late.
  first.emit("exit", 0, null);
  assert.equal(processes.running.size, 1, "the live session was evicted by a stale exit");
});

test("stopAll clears everything", async () => {
  const { processes } = harness();
  await processes.start("/projects/a");
  await processes.start("/projects/b");

  processes.stopAll();
  assert.equal(processes.running.size, 0);
});

test("refuses to start without a vendored binary", async () => {
  const processes = new ArgonProcesses({ binary: null, spawn: () => {}, probe: async () => true });
  await assert.rejects(processes.start("/projects/game"), /no vendored argon/);
});

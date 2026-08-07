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
/**
 * Runs `body` with ~/.argon/sessions.toml set to `contents`.
 *
 * The real file belongs to the developer's own argon; it is put back exactly as
 * it was, including not existing.
 */
async function withSessionsFile(contents, body) {
  const { homedir } = await import("node:os");
  const { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const path = (await import("node:path")).default;

  const file = path.join(homedir(), ".argon", "sessions.toml");
  const had = existsSync(file);
  const before = had ? readFileSync(file, "utf8") : null;

  try {
    if (contents === null) rmSync(file, { force: true });
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }

    return await body();
  } finally {
    if (had) writeFileSync(file, before);
    else rmSync(file, { force: true });
  }
}

function harness({ readyAfter = 1, neverReady = false, exitAfter = null, busy = [], says = null } = {}) {
  const spawned = [];
  // port -> probes remaining before it answers. Absent means nothing listening.
  const listeners = new Map(busy.map((port) => [port, 0]));

  const spawn = (binary, args, options) => {
    const port = Number(args[args.indexOf("--port") + 1]);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      listeners.delete(port);
      child.emit("exit", null, "SIGTERM");
    };

    spawned.push({ binary, args, options, child, port });

    if (!neverReady) listeners.set(port, readyAfter);

    // What argon prints on the way out is the whole diagnosis, so the fake has
    // to be able to say something.
    if (says !== null) setTimeout(() => child.stdout.emit("data", says), 5);
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

test("a missing binary names the exact path to put one at", async () => {
  // The fix is a file the user has to place; an error that only says
  // "unsupported" leaves them nowhere to go.
  const processes = new ArgonProcesses({ binary: null, spawn: () => {}, probe: async () => true });

  await assert.rejects(processes.start("/projects/game"), (error) => {
    assert.match(error.message, /no argon binary for/);
    assert.match(error.message, /vendor\/argon\//, "the message must include the path to drop a release at");
    return true;
  });
});

// ------------------------------------------------- adopting an orphaned serve

test("a serve that is already running is adopted, not treated as a failure", async () => {
  // The app being force-quit or crashing leaves its argon child alive. The
  // restarted app has an empty session map, so it spawns a second serve, and
  // argon refuses and names the port the first one is on.
  const { processes } = harness({
    neverReady: true,
    exitAfter: 0,
    busy: [8000],
    says: "INFO: Already serving on: http://localhost:8000 - nothing to do. Run argon stop first\n",
  });

  const session = await processes.start("/tmp/project");

  assert.equal(session.port, 8000);
  assert.equal(session.host, "localhost");
  assert.equal(session.adopted, true);
  assert.equal(session.child, null, "there is no child to kill; claiming one would make stopAll lie");
});

test("an adopted session is what the project list reports", async () => {
  const { processes } = harness({
    neverReady: true,
    exitAfter: 0,
    busy: [8000],
    says: "Already serving on: http://localhost:8000\n",
  });

  await processes.start("/tmp/project");

  assert.equal(processes.session("/tmp/project").port, 8000);
  assert.equal(processes.running.size, 1);
});

test("a session file that outlived its process is not adopted", async () => {
  // Argon can claim a port nothing is listening on. Adopting that would just
  // move the failure to the first request.
  const { processes } = harness({
    neverReady: true,
    exitAfter: 0,
    says: "Already serving on: http://localhost:8000\n",
  });

  await assert.rejects(processes.start("/tmp/project"), /exited before it was ready/);
});

test("stopping an adopted session asks argon, since there is no child", async () => {
  const { processes, spawned } = harness({
    neverReady: true,
    exitAfter: 0,
    busy: [8000],
    says: "Already serving on: http://localhost:8000\n",
  });

  await processes.start("/tmp/project");
  processes.stop("/tmp/project");

  const stop = spawned.find((s) => s.args[0] === "stop");
  assert.ok(stop, "expected an argon stop");
  assert.deepEqual(stop.args, ["stop", "--host", "localhost", "--port", "8000", "--yes"]);
});

test("argon's own words survive into the error", async () => {
  // A bare exit code sent this exact bug on a twenty minute detour; the last
  // line argon printed said precisely what was wrong.
  const { processes } = harness({
    neverReady: true,
    exitAfter: 1,
    says: "ERROR: failed to read default.project.json: expected value at line 3\n",
  });

  await assert.rejects(processes.start("/tmp/project"), /expected value at line 3/);
});

// ------------------------------------------- serves that predate this process

test("a serve running before we started is adopted, not reported as idle", async () => {
  // `running` is in memory, so an app restart forgets every serve while the
  // argon processes carry on — which showed every project as idle while sync
  // was working.
  const { processes } = harness({ busy: [8000] });

  const sessions = `last_session = "0"

[active_sessions.0]
pid = ${process.pid}
host = "localhost"
port = 8000
project = "/tmp/AGame/default.project.json"
`;

  const adopted = await withSessionsFile(sessions, () => processes.adoptRunning());

  assert.deepEqual(adopted, ["/tmp/AGame"], "keyed by the folder, not the project file");
  assert.equal(processes.session("/tmp/AGame").port, 8000);
});

test("an entry whose process is gone is not adopted", async () => {
  // A session file outlives a crash, and believing it would put the lie back
  // the other way round.
  const { processes } = harness({ busy: [8000] });

  const sessions = `[active_sessions.0]
pid = 999999
host = "localhost"
port = 8000
project = "/tmp/Dead/default.project.json"
`;

  assert.deepEqual(await withSessionsFile(sessions, () => processes.adoptRunning()), []);
});

test("an entry whose port does not answer is not adopted", async () => {
  // The pid can be alive while the serve is not: same process, different job.
  const { processes } = harness();

  const sessions = `[active_sessions.0]
pid = ${process.pid}
host = "localhost"
port = 8123
project = "/tmp/Quiet/default.project.json"
`;

  assert.deepEqual(await withSessionsFile(sessions, () => processes.adoptRunning()), []);
});

test("no session file at all is not an error", async () => {
  const { processes } = harness();
  assert.deepEqual(await withSessionsFile(null, () => processes.adoptRunning()), []);
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { socketPath, listenOnSocket, clearStaleSocket, socketIsLive } from "./socket.js";
import { Daemon } from "./index.js";

const temporary = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msync-sock-"));
  temporary.push(dir);
  return dir;
};

after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

test("the socket lives beside the settings", () => {
  assert.equal(socketPath("/x/.muslimsync"), "/x/.muslimsync/daemon.sock");
});

test("serves the same handler a port would", async () => {
  const file = socketPath(scratch());
  const server = await listenOnSocket(file, (_request, response) => response.end("hello"));

  assert.ok(server, "expected a listener");
  assert.ok(socketIsLive(file));

  const { request } = await import("node:http");
  const body = await new Promise((resolve) => {
    request({ socketPath: file, path: "/" }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve(Buffer.concat(chunks).toString()));
    }).end();
  });

  assert.equal(body, "hello");
  await new Promise((resolve) => server.close(resolve));
});

test("a socket file left by a dead process is cleared, not treated as taken", async () => {
  // A crash leaves the file behind and binding refuses while it exists, so a
  // daemon that did not clear it could never start again.
  const file = socketPath(scratch());
  writeFileSync(file, "");

  assert.equal(await clearStaleSocket(file), true);
  assert.equal(existsSync(file), false);
});

test("a socket something is actually serving is left alone", async () => {
  // Taking it would leave two daemons half-working, which is worse than
  // refusing the second.
  const file = socketPath(scratch());
  const server = await listenOnSocket(file, (_request, response) => response.end("mine"));

  assert.equal(await clearStaleSocket(file), false);
  assert.ok(existsSync(file), "the live socket must survive");

  await new Promise((resolve) => server.close(resolve));
});

test("a second daemon does not steal the first one's socket", async () => {
  const file = socketPath(scratch());
  const first = await listenOnSocket(file, (_request, response) => response.end("first"));

  assert.equal(await listenOnSocket(file, () => {}), null);

  await new Promise((resolve) => first.close(resolve));
});

test("the daemon answers on its socket and reports it in status", async () => {
  const file = socketPath(scratch());
  const daemon = new Daemon({ port: 0, socketFile: file });
  await daemon.start();

  try {
    assert.equal(daemon.status().socket, file);

    const { request } = await import("node:http");
    const body = await new Promise((resolve) => {
      request({ socketPath: file, path: "/health" }, (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => resolve(Buffer.concat(chunks).toString()));
      }).end();
    });

    assert.equal(JSON.parse(body).listening, true);
  } finally {
    await daemon.stop();
  }
});

test("stopping removes the file, so the next start can bind", async () => {
  const file = socketPath(scratch());
  const daemon = new Daemon({ port: 0, socketFile: file });

  await daemon.start();
  await daemon.stop();

  assert.equal(existsSync(file), false);
});

test("no socket path configured is not an error", async () => {
  // The headless daemon has no settings directory to put one in.
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  try {
    assert.equal(daemon.status().socket, null);
  } finally {
    await daemon.stop();
  }
});

// ------------------------------------------------------- windows pipes

test("Windows gets a named pipe, not a file in the settings folder", (t) => {
  // AF_UNIX support on Windows is partial; pipes are what actually works, and
  // Node serves and dials both through the same API.
  const real = process.platform;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(socketPath("C:\\Users\\x\\.muslimsync"), "\\\\.\\pipe\\muslimsync-daemon");
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
});

test("a named pipe is never treated as a stale file to delete", async (t) => {
  // The pipe namespace is not the filesystem: a pipe vanishes with its process,
  // so there is nothing to clean up and nothing to unlink.
  const real = process.platform;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(await clearStaleSocket("\\\\.\\pipe\\muslimsync-daemon"), true);
    assert.equal(socketIsLive("\\\\.\\pipe\\muslimsync-daemon"), true);
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
});

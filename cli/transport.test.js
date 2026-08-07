import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { send } from "./transport.js";
import { Daemon } from "../daemon/index.js";

const temporary = [];
after(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "msync-transport-"));
  temporary.push(dir);
  return dir;
};

test("prefers the socket when one is serving", async () => {
  const file = path.join(scratch(), "daemon.sock");
  const daemon = new Daemon({ port: 0, socketFile: file });
  await daemon.start();

  try {
    // A port nothing is on: answering proves TCP was never used.
    const { status, body } = await send({ port: 59999, route: "/health", socket: file });

    assert.equal(status, 200);
    assert.equal(JSON.parse(body.toString()).listening, true);
  } finally {
    await daemon.stop();
  }
});

test("falls back to TCP when the socket is dead", async () => {
  // On Windows the socket is a named pipe and cannot be stat'd, so the dial is
  // the only real test — a daemon serving TCP must stay reachable regardless.
  const file = path.join(scratch(), "daemon.sock");
  writeFileSync(file, "");

  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  try {
    const { status } = await send({ port: daemon.port, route: "/health", socket: file });
    assert.equal(status, 200);
  } finally {
    await daemon.stop();
  }
});

test("a failure names the transport it tried", async () => {
  const missing = path.join(scratch(), "nothing.sock");

  await assert.rejects(
    send({ port: 59999, route: "/health", socket: missing }),
    (error) => {
      assert.match(error.transport, /127\.0\.0\.1:59999/);
      return true;
    },
  );
});

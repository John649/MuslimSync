import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { Daemon } from "./index.js";
import { PROTOCOL, ERROR } from "./protocol.js";

// POST /op is the CLI's transport. Split out of index.test.js when that file
// crossed the line cap; the fake plugin is duplicated rather than shared so
// each file still reads on its own.

/** A fake Studio plugin: connects, says hello, answers ops from a table. */
function fakePlugin(port, { handlers = {}, hello = {}, skipHello = false } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.t !== "req") return;

    const handler = handlers[frame.op];
    if (!handler) {
      socket.send(
        JSON.stringify({ t: "res", id: frame.id, ok: false, error: { code: ERROR.UNKNOWN_OP, message: frame.op } }),
      );
      return;
    }

    const result = handler(frame.args);
    if (result === undefined) return; // deliberately silent, for timeout tests
    socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, value: result }));
  });

  return {
    socket,
    async connect() {
      await ready;
      if (!skipHello) {
        socket.send(
          JSON.stringify({ t: "hello", protocol: PROTOCOL, placeId: "123", gameId: "456", pluginVersion: "0.1.0", ...hello }),
        );
      }
      return this;
    },
    close() {
      return new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", resolve);
        socket.close();
      });
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 60));

// ---------------------------------------------------------------- POST /op
test("POST /op forwards an op to the plugin and returns its value", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { handlers: { ping: (args) => ({ pong: true, nonce: args.nonce }) } }).connect();
  await settled();

  const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, {
    method: "POST",
    body: JSON.stringify({ op: "ping", args: { nonce: 7 } }),
  });

  assert.deepEqual(await response.json(), { ok: true, value: { pong: true, nonce: 7 } });

  await plugin.close();
  await daemon.stop();
});

test("POST /op passes the plugin's error code through untranslated", async () => {
  // The CLI branches on codes. Collapsing them here would lose the difference
  // between "the plugin said no" and "nothing is connected".
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { handlers: {} }).connect();
  await settled();

  const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, {
    method: "POST",
    body: JSON.stringify({ op: "nope" }),
  });

  const body = await response.json();
  assert.equal(response.status, 200, "a plugin-level refusal is not an HTTP failure");
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR.UNKNOWN_OP);

  await plugin.close();
  await daemon.stop();
});

test("POST /op reports 503 when no plugin is connected", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, {
    method: "POST",
    body: JSON.stringify({ op: "ping" }),
  });

  assert.equal(response.status, 503, "no Studio is a transport failure, not a plugin refusal");
  assert.equal((await response.json()).error.code, ERROR.NOT_CONNECTED);

  await daemon.stop();
});

test("POST /op rejects a malformed call", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  for (const body of ["{ not json", JSON.stringify({}), JSON.stringify({ op: "" })]) {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, { method: "POST", body });
    assert.equal(response.status, 400, `expected ${body} to be refused`);
  }

  await daemon.stop();
});

test("two unpublished places do not collapse into one session", async () => {
  // Every unpublished place reports placeId 0. Keying sessions on it meant a
  // second scratch place evicted the first and they fought over one entry —
  // which is exactly what two open Studio windows look like.
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const a = await fakePlugin(daemon.port, { hello: { placeId: "0", placeName: "A" }, handlers: { who: () => "a" } }).connect();
  const b = await fakePlugin(daemon.port, { hello: { placeId: "0", placeName: "B" }, handlers: { who: () => "b" } }).connect();
  await settled();

  assert.equal(daemon.status().plugins.length, 2, "both scratch places must be their own session");

  // With no placeId given, the newest connection is the one being worked in.
  assert.equal(await daemon.request("who"), "b");

  await a.close();
  await b.close();
  await daemon.stop();
});

test("a published place still replaces its own stale session", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const first = await fakePlugin(daemon.port, { hello: { placeId: "77" }, handlers: { who: () => "first" } }).connect();
  await settled();
  const second = await fakePlugin(daemon.port, { hello: { placeId: "77" }, handlers: { who: () => "second" } }).connect();
  await settled();

  assert.equal(daemon.status().plugins.length, 1, "a reload must not leave the old session behind");
  assert.equal(await daemon.request("who", {}, { placeId: "77" }), "second");

  await first.close();
  await second.close();
  await daemon.stop();
});

test("a playtest is refused while another place is already playing", async () => {
  // Studio plays one place at a time for the whole application. Starting a
  // second does nothing, reports success, and leaves the caller waiting out a
  // context timeout for something that was never coming — which cost a real
  // session forty-five seconds of silence per call.
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const busy = await fakePlugin(daemon.port, {
    hello: { placeId: "111" },
    handlers: { playtest_status: () => ({ running: true, contexts: [{ name: "server", kind: "server" }] }) },
  }).connect();

  const idle = await fakePlugin(daemon.port, {
    hello: { placeId: "222" },
    handlers: { playtest_status: () => ({ running: false, contexts: [] }) },
  }).connect();

  await settled();

  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, {
      method: "POST",
      body: JSON.stringify({ op: "playtest_start", args: {}, placeId: "222" }),
    });

    const value = await response.json();

    assert.equal(value.ok, false);
    assert.match(value.error.message, /already playing/);
    assert.match(value.error.message, /only one place/);
  } finally {
    busy.close();
    idle.close();
    await daemon.stop();
  }
});

test("a playtest starts normally when nothing else is playing", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, {
    handlers: {
      playtest_status: () => ({ running: false, contexts: [] }),
      playtest_start: () => ({ started: true, mode: "play" }),
    },
  }).connect();

  await settled();

  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/op`, {
      method: "POST",
      body: JSON.stringify({ op: "playtest_start", args: {} }),
    });

    const value = await response.json();
    assert.equal(value.ok, true);
    assert.equal(value.value.started, true);
  } finally {
    plugin.close();
    await daemon.stop();
  }
});

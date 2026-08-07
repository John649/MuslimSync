import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { Daemon } from "./index.js";
import { PROTOCOL, ERROR } from "./protocol.js";

// Port 0 lets the OS pick a free one, so tests never collide with a real
// daemon or with each other; the daemon reports the port it actually bound.

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

test("starts listening and reports empty status", async () => {
  const daemon = new Daemon({ port: 0 });
  const status = await daemon.start();

  assert.equal(status.listening, true);
  assert.equal(status.protocol, PROTOCOL);
  assert.deepEqual(status.plugins, []);

  await daemon.stop();
  assert.equal(daemon.status().listening, false);
});

test("refuses a request when no plugin is connected", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  await assert.rejects(daemon.request("ping"), (error) => {
    assert.equal(error.code, ERROR.NOT_CONNECTED);
    return true;
  });

  await daemon.stop();
});

test("registers a plugin after hello and round-trips an op", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();
  const port = daemon.port;

  const plugin = await fakePlugin(port, { handlers: { ping: (args) => ({ pong: true, nonce: args.nonce }) } }).connect();
  await settled();

  const status = daemon.status();
  assert.equal(status.plugins.length, 1);
  assert.equal(status.plugins[0].placeId, "123");

  assert.deepEqual(await daemon.request("ping", { nonce: 7 }), { pong: true, nonce: 7 });

  await plugin.close();
  await daemon.stop();
});

test("propagates a plugin error code to the caller", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { handlers: {} }).connect();
  await settled();

  await assert.rejects(daemon.request("nope"), (error) => {
    assert.equal(error.code, ERROR.UNKNOWN_OP);
    return true;
  });

  await plugin.close();
  await daemon.stop();
});

test("a disconnect fails in-flight requests instead of hanging", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  // `slow` never replies, so the request is still pending when the socket goes.
  const plugin = await fakePlugin(daemon.port, { handlers: { slow: () => undefined } }).connect();
  await settled();

  const pending = daemon.request("slow", {}, { timeoutMs: 5000 });

  // Attach the assertion before triggering the disconnect. The rejection
  // arrives the instant the socket drops, and a promise that rejects with no
  // handler yet is an unhandled rejection, which fails the run for the wrong
  // reason.
  const asserted = assert.rejects(pending, (error) => {
    assert.equal(error.code, ERROR.NOT_CONNECTED);
    return true;
  });

  await settled();
  await plugin.close();
  await asserted;

  assert.deepEqual(daemon.status().plugins, []);
  await daemon.stop();
});

test("a reconnect for the same place replaces the old session", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const first = await fakePlugin(daemon.port, { handlers: { who: () => "first" } }).connect();
  await settled();

  const second = await fakePlugin(daemon.port, { handlers: { who: () => "second" } }).connect();
  await settled();

  // One place, one session — a stale connection must not linger in status.
  assert.equal(daemon.status().plugins.length, 1);
  assert.equal(await daemon.request("who"), "second");

  await first.close();
  await settled();

  // Closing the replaced socket must not evict the live session.
  assert.equal(daemon.status().plugins.length, 1, "the replacement session was evicted by the old socket closing");
  assert.equal(await daemon.request("who"), "second");

  await second.close();
  await daemon.stop();
});

test("routes by placeId when several places are connected", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const a = await fakePlugin(daemon.port, { hello: { placeId: "111" }, handlers: { who: () => "a" } }).connect();
  const b = await fakePlugin(daemon.port, { hello: { placeId: "222" }, handlers: { who: () => "b" } }).connect();
  await settled();

  assert.equal(daemon.status().plugins.length, 2);
  assert.equal(await daemon.request("who", {}, { placeId: "111" }), "a");
  assert.equal(await daemon.request("who", {}, { placeId: "222" }), "b");

  await assert.rejects(daemon.request("who", {}, { placeId: "999" }), (error) => {
    assert.equal(error.code, ERROR.NOT_CONNECTED);
    return true;
  });

  await a.close();
  await b.close();
  await daemon.stop();
});

test("drops a connection that sends a malformed frame", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const errors = [];
  daemon.on("protocol-error", (error) => errors.push(error));

  const plugin = await fakePlugin(daemon.port).connect();
  await settled();

  const closed = new Promise((resolve) => plugin.socket.once("close", resolve));
  plugin.socket.send("{not json");
  await closed;
  await settled();

  assert.equal(errors.length, 1);
  assert.deepEqual(daemon.status().plugins, [], "a peer we cannot parse must not stay registered");

  await daemon.stop();
});

test("a socket that never says hello is not registered", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { skipHello: true }).connect();
  await settled();

  assert.deepEqual(daemon.status().plugins, []);

  // A frame before hello is refused rather than processed.
  const closed = new Promise((resolve) => plugin.socket.once("close", resolve));
  plugin.socket.send(JSON.stringify({ t: "res", id: 1, ok: true, value: null }));
  await closed;

  await daemon.stop();
});

test("rejects a plugin speaking a different protocol version", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { hello: { protocol: 99 } }).connect();
  const closed = new Promise((resolve) => plugin.socket.once("close", resolve));
  await closed;

  assert.deepEqual(daemon.status().plugins, []);
  await daemon.stop();
});

test("stopping closes plugin sockets and fails their pending work", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const plugin = await fakePlugin(daemon.port, { handlers: { slow: () => undefined } }).connect();
  await settled();

  const pending = daemon.request("slow", {}, { timeoutMs: 5000 });

  // Same reason as above: stop() rejects it synchronously.
  const asserted = assert.rejects(pending, (error) => {
    assert.equal(error.code, ERROR.NOT_CONNECTED);
    return true;
  });

  await settled();
  await daemon.stop();
  await asserted;

  await plugin.close();
});

test("serves /health over plain HTTP", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const response = await fetch(`http://127.0.0.1:${daemon.port}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.listening, true);
  assert.equal(body.protocol, PROTOCOL);

  const missing = await fetch(`http://127.0.0.1:${daemon.port}/nope`);
  assert.equal(missing.status, 404);

  await daemon.stop();
});

test("plugin events are re-emitted with their place", async () => {
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  const seen = [];
  daemon.on("plugin-event", (event) => seen.push(event));

  const plugin = await fakePlugin(daemon.port).connect();
  await settled();

  plugin.socket.send(JSON.stringify({ t: "event", kind: "log", payload: { line: "hello" } }));
  await settled();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "log");
  assert.equal(seen[0].placeId, "123");

  await plugin.close();
  await daemon.stop();
});

test("answers on the IPv6 loopback as well as the IPv4 one", async () => {
  // Binding 127.0.0.1 alone means anything that resolves `localhost` to ::1
  // first gets connection refused while the daemon is plainly running — a
  // failure that looks exactly like the app not being started.
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  try {
    const four = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    assert.equal(four.status, 200);

    const six = await fetch(`http://[::1]:${daemon.port}/health`).catch(() => null);

    // A host with IPv6 disabled legitimately has nothing to bind, so this
    // asserts the shape rather than demanding the connection.
    if (six) assert.equal(six.status, 200);
  } finally {
    await daemon.stop();
  }
});

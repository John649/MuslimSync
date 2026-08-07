import { test } from "node:test";
import assert from "node:assert/strict";

import { Session } from "./session.js";
import { decodeFrame, ERROR } from "./protocol.js";

const HELLO = { t: "hello", protocol: 1, placeId: "123", gameId: "456", pluginVersion: "0.1.0" };

/** A session whose sent frames are captured instead of written to a socket. */
function harness({ timeoutMs = 50 } = {}) {
  const sent = [];
  const session = new Session({ send: (raw) => sent.push(JSON.parse(raw)), hello: HELLO, timeoutMs });
  const reply = (id, body) => session.handleFrame(decodeFrame(JSON.stringify({ t: "res", id, ...body })));
  return { session, sent, reply };
}

test("exposes the identity from the hello", () => {
  const { session } = harness();
  assert.equal(session.placeId, "123");
  assert.equal(session.gameId, "456");
  assert.equal(session.closed, false);
});

test("sends a well-formed request and resolves with its value", async () => {
  const { session, sent, reply } = harness();

  const pending = session.request("get", { path: "Workspace/Part" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "get");
  assert.deepEqual(sent[0].args, { path: "Workspace/Part" });

  reply(sent[0].id, { ok: true, value: { class: "Part" } });
  assert.deepEqual(await pending, { class: "Part" });
});

test("rejects with the plugin's own error code", async () => {
  const { session, sent, reply } = harness();

  const pending = session.request("get", { path: "Workspace/Missing" });
  reply(sent[0].id, { ok: false, error: { code: ERROR.NOT_FOUND, message: "no such instance" } });

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, ERROR.NOT_FOUND);
    assert.equal(error.message, "no such instance");
    return true;
  });
});

test("request ids are unique and increasing", () => {
  const { session, sent } = harness();
  for (let i = 0; i < 5; i += 1) session.request("ping").catch(() => {});

  const ids = sent.map((frame) => frame.id);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
});

test("concurrent requests resolve independently and out of order", async () => {
  const { session, sent, reply } = harness();

  const first = session.request("get", { path: "A" });
  const second = session.request("get", { path: "B" });

  // Answer them backwards: correlation must be by id, not arrival order.
  reply(sent[1].id, { ok: true, value: "B" });
  reply(sent[0].id, { ok: true, value: "A" });

  assert.deepEqual(await Promise.all([first, second]), ["A", "B"]);
});

test("times out when no response arrives", async () => {
  const { session } = harness({ timeoutMs: 20 });

  await assert.rejects(session.request("ping"), (error) => {
    assert.equal(error.code, ERROR.TIMEOUT);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a response arriving after its timeout is ignored", async () => {
  const { session, sent, reply } = harness({ timeoutMs: 20 });

  const pending = session.request("ping");
  await assert.rejects(pending, /timed out/);

  // Settling an already-rejected promise would be silent; the real symptom is
  // an unhandled rejection or a resolve that never reaches anyone. Either way
  // this must not throw.
  assert.doesNotThrow(() => reply(sent[0].id, { ok: true, value: "late" }));
  assert.equal(session.pendingCount, 0);
});

test("a duplicate response is ignored", async () => {
  const { session, sent, reply } = harness();

  const pending = session.request("ping");
  reply(sent[0].id, { ok: true, value: 1 });
  assert.equal(await pending, 1);

  assert.doesNotThrow(() => reply(sent[0].id, { ok: true, value: 2 }));
});

test("a response to an id that was never issued is ignored", () => {
  const { session, reply } = harness();
  assert.doesNotThrow(() => reply(9999, { ok: true, value: 1 }));
});

test("timing out clears the pending entry so it cannot leak", async () => {
  const { session } = harness({ timeoutMs: 10 });
  await assert.rejects(session.request("ping"), /timed out/);
  assert.equal(session.pendingCount, 0);
});

test("closing fails every in-flight request rather than hanging", async () => {
  const { session } = harness({ timeoutMs: 5000 });

  const requests = [session.request("a"), session.request("b"), session.request("c")];
  session.close();

  for (const pending of requests) {
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, ERROR.NOT_CONNECTED);
      assert.equal(error.retryable, true);
      return true;
    });
  }

  assert.equal(session.pendingCount, 0);
  assert.equal(session.closed, true);
});

test("requesting on a closed session rejects immediately", async () => {
  const { session, sent } = harness();
  session.close();

  await assert.rejects(session.request("ping"), (error) => {
    assert.equal(error.code, ERROR.NOT_CONNECTED);
    return true;
  });

  assert.equal(sent.length, 0, "a closed session must not write to the socket");
});

test("closing twice is safe", () => {
  const { session } = harness();
  session.close();
  assert.doesNotThrow(() => session.close());
});

test("a send failure rejects that request and does not leak it", async () => {
  const session = new Session({
    send: () => {
      throw new Error("socket is gone");
    },
    hello: HELLO,
    timeoutMs: 5000,
  });

  await assert.rejects(session.request("ping"), /socket is gone/);
  assert.equal(session.pendingCount, 0, "a failed send must not leave a pending entry behind");
});

test("events reach subscribers and unsubscribe cleanly", () => {
  const { session } = harness();
  const seen = [];

  const stop = session.onEvent((event) => seen.push(event.kind));
  session.handleFrame({ t: "event", kind: "log", payload: null });
  stop();
  session.handleFrame({ t: "event", kind: "log", payload: null });

  assert.deepEqual(seen, ["log"]);
});

test("an event never settles a pending request", async () => {
  const { session, sent, reply } = harness({ timeoutMs: 5000 });

  const pending = session.request("ping");
  session.handleFrame({ t: "event", kind: "log", payload: null });

  assert.equal(session.pendingCount, 1);
  reply(sent[0].id, { ok: true, value: "pong" });
  assert.equal(await pending, "pong");
});

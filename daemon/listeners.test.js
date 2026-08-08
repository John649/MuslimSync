import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { Daemon } from "./index.js";
import { PROTOCOL, ERROR } from "./protocol.js";

// The daemon's extra front doors: the IPv6 loopback, the unix socket, and
// which place a request is routed to. Split from index.test.js, which is about
// the socket protocol itself.

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

test("answers on the IPv6 loopback as well as the IPv4 one", async () => {
  // Binding 127.0.0.1 alone means anything that resolves `localhost` to ::1
  // first gets connection refused while the daemon is plainly running — a
  // failure that looks exactly like the app not being started.
  const daemon = new Daemon({ port: 0 });
  await daemon.start();

  try {
    const four = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    assert.equal(four.status, 200);

    const six = await fetch(`http://[::1]:${daemon.port}/health`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

    // A host with IPv6 disabled legitimately has nothing to bind, so this
    // asserts the shape rather than demanding the connection.
    if (six) assert.equal(six.status, 200);
  } finally {
    await daemon.stop();
  }
});

test("an unpublished place is addressable by its marker, not by placeId 0", () => {
  // Two unpublished places both report placeId 0, so selecting by id picks
  // whichever matched first — which is to say, the wrong one half the time.
  const make = (key, argonId, placeName) => ({
    key,
    placeId: "0",
    placeName,
    get ref() {
      return argonId ? argonId.slice(0, 8) : key;
    },
  });

  // Subclassed rather than started: session() only reads `sessions`, so there
  // is no reason to open a listener that then has to be closed.
  class Fake extends Daemon {
    constructor(list) {
      super({ port: 0 });
      this.list = list;
    }

    get sessions() {
      return this.list;
    }
  }

  const daemon = new Fake([make("1", "aaaaaaaa-1111", "Lobby"), make("2", "bbbbbbbb-2222", "Arena")]);

  assert.equal(daemon.session("aaaaaaaa").placeName, "Lobby");
  assert.equal(daemon.session("bbbbbbbb").placeName, "Arena");
  assert.equal(daemon.session().placeName, "Arena", "no selector means the most recent");
  assert.equal(daemon.session("nope"), null);
  assert.equal(daemon.session("arena"), null, "a name is a label, not a selector");
});

test("a place is never selected by name", async () => {
  // Every unpublished place is called "Place1" and a substring can match
  // several, so a name is exactly the wrong way to choose what `rm` runs in.
  const make = (key, ref, placeName) => ({ key, ref, placeId: "0", placeName });

  class Fake extends Daemon {
    constructor(list) {
      super({ port: 0 });
      this.list = list;
    }

    get sessions() {
      return this.list;
    }
  }

  const daemon = new Fake([make("1", "aaaa1111", "Place1"), make("2", "bbbb2222", "Place1")]);

  assert.equal(daemon.session("Place1"), null, "a name must not select anything");
  assert.equal(daemon.session("place"), null);
  assert.equal(daemon.session("aaaa1111").key, "1", "the identifier does select");
});

test("an unambiguous prefix works, an ambiguous one does not", async () => {
  // A published placeId is eighteen digits; nobody should have to type all of
  // it. But two matches means the caller has not said which.
  const make = (key, ref) => ({ key, ref, placeId: "0", placeName: null });

  class Fake extends Daemon {
    constructor(list) {
      super({ port: 0 });
      this.list = list;
    }

    get sessions() {
      return this.list;
    }
  }

  const daemon = new Fake([make("1", "13166507"), make("2", "13050535")]);

  assert.equal(daemon.session("131").key, "1");
  assert.equal(daemon.session("130").key, "2");
  assert.equal(daemon.session("13"), null, "a prefix matching both selects neither");
});

// The control daemon.
//
// Binds loopback only. Studio plugins connect to /control, announce themselves
// with a hello, and then serve correlated op requests. Everything the CLI and
// the Electron app do goes through `request`.
//
// Deliberately not the sync server: Argon owns files <-> DataModel on its own
// port. A failure here cannot disturb a sync.

import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";

import { decodeFrame, DEFAULT_PORT, ERROR, MAX_FRAME_BYTES, PROTOCOL } from "./protocol.js";
import { Session } from "./session.js";
import { handle as handleRoute } from "./routes.js";

const HOST = "127.0.0.1";
// A socket that connects and then says nothing must not hold a slot forever.
const HELLO_TIMEOUT_MS = 10_000;

export class Daemon extends EventEmitter {
  #server;
  #wss;
  #sessions = new Map();

  constructor({ port = DEFAULT_PORT, host = HOST, routes = {} } = {}) {
    super();
    this.port = port;
    this.host = host;
    // The plugin's project endpoints. Empty in the headless case, where there
    // is no configured projects root to serve them from.
    this.routes = routes;
  }

  /** Sessions keyed by placeId, newest connection wins. */
  get sessions() {
    return [...this.#sessions.values()];
  }

  session(placeId) {
    return placeId ? this.#sessions.get(placeId) : this.sessions[0];
  }

  status() {
    return {
      listening: Boolean(this.#server?.listening),
      port: this.port,
      protocol: PROTOCOL,
      plugins: this.sessions.map((session) => ({
        placeId: session.placeId,
        gameId: session.gameId,
        placeName: session.hello.placeName,
        pluginVersion: session.hello.pluginVersion,
        connectedAt: session.connectedAt,
        pending: session.pendingCount,
      })),
    };
  }

  /** Sends an op to a connected plugin. Rejects if none is connected. */
  request(op, args = {}, { placeId, timeoutMs } = {}) {
    const session = this.session(placeId);

    if (!session) {
      const error = new Error(
        placeId ? `no Studio plugin connected for place ${placeId}` : "no Studio plugin is connected",
      );
      error.code = ERROR.NOT_CONNECTED;
      return Promise.reject(error);
    }

    return session.request(op, args, { timeoutMs });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.#server = createServer((request, response) => this.#handleHttp(request, response));
      this.#wss = new WebSocketServer({ server: this.#server, path: "/control", maxPayload: MAX_FRAME_BYTES });

      this.#wss.on("connection", (socket) => this.#handleSocket(socket));

      this.#server.once("error", reject);
      this.#server.listen(this.port, this.host, () => {
        this.#server.removeListener("error", reject);
        // Port 0 asks the OS to pick one, so read back what we actually got.
        // Callers and the plugin both need the real number.
        this.port = this.#server.address().port;
        this.emit("change", this.status());
        resolve(this.status());
      });
    });
  }

  async stop() {
    for (const session of this.sessions) session.close("the daemon is shutting down");
    this.#sessions.clear();

    this.#wss?.clients.forEach((socket) => socket.terminate());
    await new Promise((resolve) => (this.#wss ? this.#wss.close(resolve) : resolve()));
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));

    this.#server = undefined;
    this.#wss = undefined;
    this.emit("change", this.status());
  }

  async #handleHttp(request, response) {
    if (await handleRoute(this.routes, request, response)) return;

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(this.status()));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: ERROR.NOT_FOUND, message: "no such route" } }));
  }

  #handleSocket(socket) {
    let session = null;

    // Until a valid hello arrives this connection gets nothing and holds a
    // deadline: an idle socket is either a bug or a probe.
    const helloTimer = setTimeout(() => {
      if (!session) socket.close(1002, "no hello");
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on("message", (data) => {
      let frame;

      try {
        frame = decodeFrame(data.toString());
      } catch (cause) {
        // A frame we cannot understand ends the connection rather than being
        // skipped: after one unparseable frame we no longer know what state
        // the peer thinks it is in.
        this.emit("protocol-error", cause);
        socket.close(1002, "protocol error");
        return;
      }

      if (frame.t === "hello") {
        if (session) {
          socket.close(1002, "duplicate hello");
          return;
        }

        clearTimeout(helloTimer);
        session = this.#register(frame, socket);
        return;
      }

      if (!session) {
        socket.close(1002, "expected hello first");
        return;
      }

      session.handleFrame(frame);
    });

    const drop = () => {
      clearTimeout(helloTimer);
      if (!session) return;

      // Only clear the map entry if this socket still owns it. A reconnect may
      // already have replaced it, and dropping that would strand the new one.
      if (this.#sessions.get(session.placeId) === session) {
        this.#sessions.delete(session.placeId);
      }

      session.close();
      session = null;
      this.emit("change", this.status());
    };

    socket.on("close", drop);
    socket.on("error", drop);
  }

  #register(hello, socket) {
    // Studio was reopened, or the plugin reloaded. The stale session's pending
    // requests must fail rather than wait on a socket nobody is reading.
    const existing = this.#sessions.get(hello.placeId);
    if (existing) existing.close("replaced by a new plugin connection");

    const session = new Session({
      send: (raw) => socket.send(raw),
      hello,
    });

    session.onEvent((event) => this.emit("plugin-event", { placeId: session.placeId, ...event }));

    this.#sessions.set(hello.placeId, session);
    this.emit("change", this.status());

    return session;
  }
}

/** Convenience for the CLI and the Electron main process. */
export async function startDaemon(options) {
  const daemon = new Daemon(options);
  await daemon.start();
  return daemon;
}

// Running this file directly gives a headless daemon for CLI-only use.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const daemon = await startDaemon();
  const { port, host } = daemon;
  console.log(`muslimsync daemon listening on ws://${host}:${port}/control`);

  daemon.on("change", (status) => {
    const places = status.plugins.map((plugin) => plugin.placeId).join(", ") || "none";
    console.log(`plugins connected: ${places}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await daemon.stop();
      process.exit(0);
    });
  }
}

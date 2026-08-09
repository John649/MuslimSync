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
import { rmSync } from "node:fs";

import { listenOnIpv6, listenOnUnix } from "./listeners.js";
import { handleOp } from "./op.js";
import { isPipe } from "./socket.js";

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
  #ipv6 = null;
  #socket = null;
  #nextSessionId = 1;
  // The cross-project clipboard. A copy in one place has to be pasteable in
  // another without the caller carrying an artifact id around by hand — that
  // is the entire point of calling it a clipboard.
  clipboard = null;

  constructor({ port = DEFAULT_PORT, host = HOST, routes = {}, socketFile = null, serving = () => [] } = {}) {
    super();
    this.port = port;
    // Optional second front door: a unix socket, for shells that sandbox
    // loopback networking. Null means TCP only.
    this.socketFile = socketFile;
    // Which projects are being synced. `source` uses it to refuse reading a
    // script through Studio when the same script is a file on disk.
    this.serving = serving;
    this.host = host;
    // The plugin's project endpoints. Empty in the headless case, where there
    // is no configured projects root to serve them from.
    this.routes = routes;
  }

  /** Sessions keyed by placeId, newest connection wins. */
  get sessions() {
    return [...this.#sessions.values()];
  }

  /**
   * Picks a session. Without a placeId, the most recently connected one — with
   * several scratch places open, the newest is the one being worked in.
   */
  /**
   * The session a request should go to.
   *
   * Selection is by identifier only — never by name. Every unpublished place
   * is called "Place1", and a substring can match several, so a name is exactly
   * the wrong way to choose the target of an `rm`.
   *
   * An identifier is the placeId when published, the argonId marker when not,
   * and the connection key when a place has neither. A prefix works when it
   * picks out exactly one; an ambiguous prefix selects nothing rather than
   * guessing.
   *
   * With nothing given it is the most recently connected place. That is a guess
   * dressed as a default, so `sessions.length > 1` is reported to the caller,
   * which turns it into something the CLI can warn about rather than something
   * that silently writes to the wrong game.
   */
  session(place) {
    if (!place) return this.sessions.at(-1);

    const wanted = String(place).toLowerCase();

    const exact =
      this.sessions.find((session) => session.ref.toLowerCase() === wanted) ??
      this.sessions.find((session) => session.key === wanted) ??
      this.sessions.find((session) => session.placeId === String(place));

    if (exact) return exact;

    // A full placeId is eighteen digits, so a prefix is worth accepting — but
    // only when it is unambiguous. Two matches means the caller has not said
    // which, and picking one would be the guess this exists to prevent.
    const prefixed = this.sessions.filter(
      (session) => session.ref.toLowerCase().startsWith(wanted) || session.key.startsWith(wanted),
    );

    return prefixed.length === 1 ? prefixed[0] : null;
  }

  status() {
    return {
      listening: Boolean(this.#server?.listening),
      port: this.port,
      protocol: PROTOCOL,
      socket: this.#socket ? this.socketFile : null,
      // The default target, so a caller can see which place it is about to
      // write to rather than discovering it afterwards.
      target: this.sessions.at(-1)?.ref ?? null,
      serving: this.serving(),
      plugins: this.sessions.map((session) => ({
        ref: session.ref,
        session: session.key,
        placeId: session.placeId,
        gameId: session.gameId,
        // For inferring the target from the working directory: an unpublished
        // place has no usable placeId, and this is what identifies it.
        argonId: session.hello.argonId ?? null,
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
        placeId
          ? `no connected place matches "${placeId}". Open ones: ${
              this.sessions.map((s) => `${s.ref} (${s.placeName ?? "unnamed"})`).join(", ") || "none"
            }`
          : "no Studio plugin is connected",
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

        // Also answer on the IPv6 loopback. Binding 127.0.0.1 alone means
        // anything that resolves `localhost` to ::1 first — which some tools
        // and some shells do — gets connection refused while the daemon is
        // plainly running. Loopback either way, so nothing new is exposed.
        const extras = { onRequest: (req, res) => this.#handleHttp(req, res), wss: this.#wss, path: "/control" };

        Promise.all([
          listenOnIpv6(this.port, extras).then((server) => (this.#ipv6 = server)),
          listenOnUnix(this.socketFile, extras).then((server) => (this.#socket = server)),
        ]).finally(() => {
          this.emit("change", this.status());
          resolve(this.status());
        });
      });
    });
  }


  async stop() {
    for (const session of this.sessions) session.close("the daemon is shutting down");
    this.#sessions.clear();

    this.#wss?.clients.forEach((socket) => socket.terminate());
    await new Promise((resolve) => (this.#wss ? this.#wss.close(resolve) : resolve()));
    await new Promise((resolve) => (this.#socket ? this.#socket.close(resolve) : resolve()));
    // The file outlives the listener, and a leftover one blocks the next bind.
    // A named pipe is not a file: it goes with the closed server and unlinking
    // it fails outright.
    if (this.socketFile && !isPipe(this.socketFile)) rmSync(this.socketFile, { force: true });
    this.#socket = null;

    await new Promise((resolve) => (this.#ipv6 ? this.#ipv6.close(resolve) : resolve()));
    this.#ipv6 = null;
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));

    this.#server = undefined;
    this.#wss = undefined;
    this.emit("change", this.status());
  }

  async #handleHttp(request, response) {
    if (await handleRoute(this.routes, request, response)) return;

    // The CLI's transport: one op in, one result out. JSON rather than MsgPack
    // because this side is ours, not Argon's.
    if (request.method === "POST" && request.url === "/op") {
      await handleOp(this, request, response);
      return;
    }

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
      if (this.#sessions.get(session.key) === session) {
        this.#sessions.delete(session.key);
      }

      session.close();
      session = null;
      this.emit("change", this.status());
    };

    socket.on("close", drop);
    socket.on("error", drop);
  }

  #register(hello, socket) {
    this.emit("op", { op: "connect", ok: true, note: hello.placeName ?? `place ${hello.placeId}` });

    // Sessions are keyed by a connection id, not by placeId. Every unpublished
    // place reports placeId 0, so keying on it meant two scratch places open at
    // once collapsed into one session and fought over it — found by opening a
    // second place to test cross-project paste.
    //
    // A published place still gets replace-on-reconnect, which is what makes a
    // Studio reload or plugin reload clean up after itself.
    if (hello.placeId !== "0") {
      for (const [key, existing] of this.#sessions) {
        if (existing.placeId === hello.placeId) {
          existing.close("replaced by a new plugin connection");
          this.#sessions.delete(key);
        }
      }
    }

    const session = new Session({
      send: (raw) => socket.send(raw),
      hello,
    });

    session.key = String(this.#nextSessionId++);
    session.onEvent((event) => this.emit("plugin-event", { placeId: session.placeId, ...event }));

    this.#sessions.set(session.key, session);
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

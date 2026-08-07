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

import { listenOnSocket } from "./socket.js";

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
  #clipboard = null;

  constructor({ port = DEFAULT_PORT, host = HOST, routes = {}, socketFile = null } = {}) {
    super();
    this.port = port;
    // Optional second front door: a unix socket, for shells that sandbox
    // loopback networking. Null means TCP only.
    this.socketFile = socketFile;
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
  session(placeId) {
    if (!placeId) return this.sessions.at(-1);
    return this.sessions.find((session) => session.placeId === String(placeId));
  }

  status() {
    return {
      listening: Boolean(this.#server?.listening),
      port: this.port,
      protocol: PROTOCOL,
      socket: this.#socket ? this.socketFile : null,
      plugins: this.sessions.map((session) => ({
        session: session.key,
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

        // Also answer on the IPv6 loopback. Binding 127.0.0.1 alone means
        // anything that resolves `localhost` to ::1 first — which some tools
        // and some shells do — gets connection refused while the daemon is
        // plainly running. Loopback either way, so nothing new is exposed.
        Promise.all([this.#listenOnIpv6Loopback(), this.#listenOnUnixSocket()]).finally(() => {
          this.emit("change", this.status());
          resolve(this.status());
        });
      });
    });
  }

  /**
   * Second listener on ::1, sharing the same handlers.
   *
   * Best effort: a host with IPv6 disabled has nothing to bind, and that is not
   * a reason to refuse to start.
   */
  #listenOnIpv6Loopback() {
    return new Promise((resolve) => {
      const server = createServer((request, response) => this.#handleHttp(request, response));

      server.once("error", () => {
        server.close();
        resolve();
      });

      server.listen(this.port, "::1", () => {
        this.#ipv6 = server;
        // The websocket server attaches to the upgrade event, so the second
        // listener needs its own hand-off to the same pool.
        server.on("upgrade", (request, socket, head) => {
          // The IPv4 listener gets path filtering from the WebSocketServer's
          // own `path` option; this one has to do it by hand.
          if (new URL(request.url, "http://localhost").pathname !== "/control") {
            socket.destroy();
            return;
          }

          this.#wss.handleUpgrade(request, socket, head, (ws) => this.#wss.emit("connection", ws, request));
        });
        resolve();
      });
    });
  }

  /**
   * Serves the same routes on a unix socket, when one was configured.
   *
   * A network sandbox blocks loopback TCP but not a file, which is what makes
   * this the difference between `msync ls` working inside an agent shell and
   * dying at EPERM.
   */
  async #listenOnUnixSocket() {
    if (!this.socketFile) return;

    this.#socket = await listenOnSocket(
      this.socketFile,
      (request, response) => this.#handleHttp(request, response),
      {
        onUpgrade: (request, socket, head) => {
          if (new URL(request.url, "http://localhost").pathname !== "/control") {
            socket.destroy();
            return;
          }

          this.#wss.handleUpgrade(request, socket, head, (ws) => this.#wss.emit("connection", ws, request));
        },
      },
    );
  }

  async stop() {
    for (const session of this.sessions) session.close("the daemon is shutting down");
    this.#sessions.clear();

    this.#wss?.clients.forEach((socket) => socket.terminate());
    await new Promise((resolve) => (this.#wss ? this.#wss.close(resolve) : resolve()));
    await new Promise((resolve) => (this.#socket ? this.#socket.close(resolve) : resolve()));
    // The file outlives the listener, and a leftover one blocks the next bind.
    if (this.socketFile) rmSync(this.socketFile, { force: true });
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
      await this.#handleOp(request, response);
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

  async #handleOp(request, response) {
    const chunks = [];
    let total = 0;

    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_FRAME_BYTES) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }

    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    let call;
    try {
      call = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      reply(400, { ok: false, error: { code: ERROR.INVALID_ARGUMENT, message: "body is not valid JSON" } });
      return;
    }

    if (typeof call.op !== "string" || !call.op) {
      reply(400, { ok: false, error: { code: ERROR.INVALID_ARGUMENT, message: "op is required" } });
      return;
    }

    const args = { ...(call.args ?? {}) };

    // Paste with no artifact means "the last thing copied".
    if (call.op === "clipboard_paste" && !args.artifact) {
      if (!this.#clipboard) {
        reply(200, {
          ok: false,
          error: { code: ERROR.NOT_FOUND, message: "the clipboard is empty — copy something first", retryable: false },
        });
        return;
      }
      args.artifact = this.#clipboard;
    }

    try {
      const startedAt = Date.now();

      const value = await this.request(call.op, args, {
        placeId: call.placeId,
        timeoutMs: Number.isFinite(call.timeoutMs) ? call.timeoutMs : undefined,
      });

      if (call.op === "clipboard_copy" && value?.artifact) this.#clipboard = value.artifact;

      // Every served op is emitted, which is what makes an activity view worth
      // opening: without it the feed only fills up when something goes wrong.
      this.emit("op", { op: call.op, ok: true, ms: Date.now() - startedAt });

      reply(200, { ok: true, value });
    } catch (cause) {
      this.emit("op", { op: call.op, ok: false, error: cause.message });
      // The plugin's own error codes reach the caller intact — the CLI branches
      // on them, so translating here would lose the distinction between
      // "not connected" and "the plugin said no".
      const status = cause.code === ERROR.NOT_CONNECTED ? 503 : 200;
      reply(status, {
        ok: false,
        error: { code: cause.code ?? ERROR.PLUGIN_ERROR, message: cause.message, retryable: cause.retryable === true },
      });
    }
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

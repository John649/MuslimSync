// The daemon's extra front doors.
//
// The main listener is TCP on 127.0.0.1, which is what Studio can reach. These
// two exist for everything else: ::1 because some tools resolve `localhost` to
// IPv6 first and would otherwise get connection refused while the daemon is
// plainly running, and a unix socket because agent shells commonly sandbox
// loopback networking and a socket is a file rather than a connection.
//
// Both are best effort. A daemon that refuses to start because an optional
// door is unavailable would be worse than one without it.

import { createServer } from "node:http";

import { listenOnSocket } from "./socket.js";

/** Hands an upgrade to an existing WebSocketServer, path-checked by hand. */
function forwardUpgrade(wss, path) {
  return (request, socket, head) => {
    // The primary listener gets this from the WebSocketServer's `path` option;
    // a second listener has to do it itself.
    if (new URL(request.url, "http://localhost").pathname !== path) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}

/** A second listener on the IPv6 loopback. Resolves to the server, or null. */
export function listenOnIpv6(port, { onRequest, wss, path }) {
  return new Promise((resolve) => {
    const server = createServer(onRequest);

    server.once("error", () => {
      // No IPv6 on this host, or something else already has the address.
      server.close();
      resolve(null);
    });

    server.listen(port, "::1", () => {
      server.on("upgrade", forwardUpgrade(wss, path));
      resolve(server);
    });
  });
}

/** The unix socket, when one was configured. Resolves to the server, or null. */
export function listenOnUnix(file, { onRequest, wss, path }) {
  if (!file) return Promise.resolve(null);

  return listenOnSocket(file, onRequest, { onUpgrade: forwardUpgrade(wss, path) });
}

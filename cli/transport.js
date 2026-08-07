// Talking to the daemon.
//
// Over a unix socket when one is there, over TCP otherwise. The socket exists
// because agent shells commonly sandbox loopback networking — connecting to
// 127.0.0.1 fails with EPERM whatever the port — while a socket file is gated
// by filesystem permissions and passes straight through.
//
// The fallback matters: a headless daemon started without a socket path, or a
// platform that cannot make one, still answers on TCP.

import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { socketIsLive } from "../daemon/socket.js";

/** Where the app puts it. Mirrors app/settings.js's DIR. */
export function defaultSocket() {
  return path.join(homedir(), ".muslimsync", "daemon.sock");
}

/**
 * One request, over whichever transport is available.
 *
 * Returns { status, body } with the body as a Buffer, because the artifact
 * routes are MsgPack and the rest are JSON.
 */
export function send({ port, route, method = "GET", body = null, headers = {}, socket = defaultSocket() }) {
  const overSocket = socketIsLive(socket);

  const options = overSocket
    ? { socketPath: socket, path: route, method, headers }
    : { host: "127.0.0.1", port, path: route, method, headers };

  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });

    req.on("error", (error) => {
      // Name the transport that failed. "ECONNREFUSED" against a socket path
      // and against a port mean different things to whoever has to fix it.
      error.transport = overSocket ? `unix:${socket}` : `127.0.0.1:${port}`;
      reject(error);
    });

    if (body) req.write(body);
    req.end();
  });
}

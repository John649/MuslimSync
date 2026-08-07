// A unix socket alongside the TCP listener.
//
// Agent shells commonly sandbox outbound networking, and that includes
// loopback: connecting to 127.0.0.1 fails with EPERM whatever port you pick.
// Argon and Ro Sync are usable from inside such a shell because an agent drives
// them by editing files — their daemons watch the filesystem, so nothing has to
// open a socket. MuslimSync's control channel had no such path, so every
// `msync ls` died at the sandbox boundary.
//
// A unix socket is a file. It is gated by filesystem permissions rather than by
// the network stack, so a network sandbox does not touch it. Same server, same
// routes, different front door.
//
// The TCP listener stays: Studio can only speak HTTP and WebSocket, so the
// plugin has no way to reach a socket file.

import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

/** Where the socket lives. Beside the settings, which is already ours. */
export function socketPath(directory) {
  return path.join(directory, "daemon.sock");
}

/**
 * Removes a socket file left behind by a process that is gone.
 *
 * A crash leaves the file in place, and binding refuses while it exists. Only
 * safe because we check first that nothing is actually listening on it.
 */
export async function clearStaleSocket(file) {
  if (!existsSync(file)) return true;

  const listening = await new Promise((resolve) => {
    const probe = connect(file)
      .on("connect", () => {
        probe.end();
        resolve(true);
      })
      .on("error", () => resolve(false));
  });

  if (listening) return false;

  rmSync(file, { force: true });
  return true;
}

/**
 * Serves `handler` on a unix socket.
 *
 * Returns null rather than throwing when the socket cannot be created: a
 * daemon that refuses to start because an optional second front door is
 * unavailable would be worse than one without it.
 */
export async function listenOnSocket(file, handler, { onUpgrade } = {}) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });

    if (!(await clearStaleSocket(file))) {
      // Something is already serving here. That is another daemon, and taking
      // its socket would leave both half-working.
      return null;
    }

    const server = createServer(handler);
    if (onUpgrade) server.on("upgrade", onUpgrade);

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    return server;
  } catch {
    // Windows before build 17063, a read-only home, a path too long for
    // sun_path. None is a reason to fail the whole daemon.
    return null;
  }
}

/** True when something is listening on the socket right now. */
export function socketIsLive(file) {
  try {
    return existsSync(file) && statSync(file).isSocket();
  } catch {
    return false;
  }
}

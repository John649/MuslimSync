// Lifecycle for the vendored `argon serve` process, one per project.
//
// Argon is a black box here: we start it, wait for its port to answer, and stop
// it. Nothing in MuslimSync reaches into how it syncs.
//
// `spawn` and `probe` are injectable so the state machine — port allocation,
// readiness, crash-before-ready, double start, stop — is testable without
// launching real processes.

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BASE_PORT = 8000;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 150;

/** The vendor directory name for this platform, or null when unsupported. */
export function platformSlug() {
  return {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    win32: { x64: "windows-x86_64" },
    linux: { x64: "linux-x86_64" },
  }[process.platform]?.[process.arch] ?? null;
}

/** The vendored binary for this platform, or null when it is not present. */
export function vendoredArgon() {
  const platform = platformSlug();

  if (!platform) return null;

  const binary = path.join(ROOT, "vendor", "argon", platform, process.platform === "win32" ? "argon.exe" : "argon");

  return existsSync(binary) ? binary : null;
}

/** Resolves true if something is listening. Used to decide when argon is up. */
export function probePort(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ArgonProcesses {
  #sessions = new Map();
  #starting = new Map();

  constructor({ binary = vendoredArgon(), host = "localhost", basePort = DEFAULT_BASE_PORT, spawn = nodeSpawn, probe = probePort, now = () => Date.now() } = {}) {
    this.binary = binary;
    this.host = host;
    this.basePort = basePort;
    this.spawn = spawn;
    this.probe = probe;
    this.now = now;
  }

  /**
   * Adopts serves that were already running before this process started.
   *
   * `running` is in memory, so an app restart forgets every serve while the
   * argon processes themselves carry on — which showed every project as "idle"
   * while sync was plainly working. Argon writes what it is serving to
   * ~/.argon/sessions.toml, so that is what gets read.
   *
   * Each entry is checked twice before being believed: the pid has to exist and
   * the port has to answer. A session file outlives a crash, and adopting a
   * dead entry would put the lie back the other way round.
   */
  async adoptRunning() {
    const file = path.join(homedir(), ".argon", "sessions.toml");

    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }

    const adopted = [];

    for (const block of text.split(/\[active_sessions\.[^\]]+\]/).slice(1)) {
      const pid = Number(block.match(/pid\s*=\s*(\d+)/)?.[1]);
      const port = Number(block.match(/port\s*=\s*(\d+)/)?.[1]);
      const host = block.match(/host\s*=\s*"([^"]+)"/)?.[1] ?? this.host;
      const project = block.match(/project\s*=\s*"([^"]+)"/)?.[1];

      if (!pid || !port || !project) continue;

      try {
        // Signal 0 tests for existence without touching the process.
        process.kill(pid, 0);
      } catch {
        continue;
      }

      if (!(await this.probe(port, host))) continue;

      // The file names the project file; the map is keyed by its folder.
      const projectPath = path.dirname(project);

      if (this.#sessions.has(projectPath)) continue;

      this.#sessions.set(projectPath, {
        host,
        port,
        startedAt: this.now(),
        child: null,
        path: projectPath,
        adopted: true,
      });

      adopted.push(projectPath);
    }

    return adopted;
  }

  /** Sessions keyed by canonical project path, for projects.list(). */
  get running() {
    return this.#sessions;
  }

  session(projectPath) {
    return this.#sessions.get(projectPath) ?? null;
  }

  async #freePort() {
    for (let port = this.basePort; port < this.basePort + 200; port += 1) {
      const taken = [...this.#sessions.values()].some((session) => session.port === port);
      if (taken) continue;
      if (!(await this.probe(port, "127.0.0.1", 200))) return port;
    }

    throw new Error("no free port for argon serve");
  }

  /**
   * Starts serving a project, or returns the session already serving it.
   *
   * Concurrent starts for the same project share one attempt: the plugin and
   * the app can both ask at once, and two `argon serve` processes on one
   * directory would fight over the same files.
   */
  async start(projectPath) {
    const existing = this.#sessions.get(projectPath);
    if (existing) return existing;

    const inFlight = this.#starting.get(projectPath);
    if (inFlight) return inFlight;

    const attempt = this.#launch(projectPath).finally(() => this.#starting.delete(projectPath));
    this.#starting.set(projectPath, attempt);

    return attempt;
  }

  /**
   * Takes over a serve that is already running for this project.
   *
   * Returns null when argon said something else, or when the port it named is
   * not actually answering — a session file can outlive the process that wrote
   * it, and adopting a dead one would just move the failure later.
   */
  async #adopt(projectPath, output) {
    const match = /already serving on:?\s*https?:\/\/([\w.-]+):(\d+)/i.exec(output);
    if (!match) return null;

    const [, host, port] = match;
    if (!(await this.probe(Number(port), host))) return null;

    const session = {
      host,
      port: Number(port),
      startedAt: this.now(),
      // Null because we did not spawn it: there is no child to kill, and
      // pretending otherwise would make stopAll look like it worked.
      child: null,
      path: projectPath,
      adopted: true,
    };

    this.#sessions.set(projectPath, session);

    return session;
  }

  async #launch(projectPath) {
    if (!this.binary) {
      // Actionable, because the fix is a file the user has to put somewhere —
      // no amount of retrying will produce it.
      throw new Error(
        `no argon binary for ${process.platform}/${process.arch}. ` +
          `Download an argon release and place it at vendor/argon/${platformSlug()}/` +
          (process.platform === "win32" ? "argon.exe" : "argon"),
      );
    }

    const port = await this.#freePort();

    const child = this.spawn(this.binary, ["serve", projectPath, "--port", String(port), "--yes"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Argon explains itself on the way out, and throwing that away turned
    // "already serving on 8000" — which says exactly what to do — into a bare
    // exit code that says nothing.
    let output = "";
    const collect = (chunk) => {
      output += String(chunk);
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let exited = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      // Only forget the session if this child still owns it, so a restart that
      // already replaced it is not torn down by the old process exiting.
      if (this.#sessions.get(projectPath)?.child === child) this.#sessions.delete(projectPath);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      // A crash before the port opens is the common failure — a bad project
      // file, or a port that was taken between the check and the spawn. Report
      // it instead of waiting out the full timeout.
      if (exited) {
        // A serve we did not spawn is still a serve. Argon refuses to start a
        // second one for the same project and names the port the first is on,
        // which happens whenever the app was force-quit or crashed: the child
        // outlives it, and the restarted app has an empty session map.
        const adopted = await this.#adopt(projectPath, output);
        if (adopted) return adopted;

        throw new Error(
          `argon serve exited before it was ready (code ${exited.code ?? exited.signal})` +
            (output.trim() ? `: ${output.trim().split("\n").at(-1)}` : ""),
        );
      }

      if (await this.probe(port)) {
        const session = { host: this.host, port, startedAt: this.now(), child, path: projectPath };
        this.#sessions.set(projectPath, session);
        return session;
      }

      await wait(READY_POLL_MS);
    }

    child.kill();
    throw new Error(`argon serve did not open port ${port} within ${READY_TIMEOUT_MS}ms`);
  }

  /**
   * Stops a serve we adopted rather than spawned.
   *
   * There is no child to kill, so argon is asked to stop it by address. Without
   * this an adopted session outlives the app exactly like the orphan it was,
   * and the next launch adopts it again forever.
   */
  #stopAdopted(session) {
    try {
      this.spawn(this.binary, ["stop", "--host", session.host, "--port", String(session.port), "--yes"], {
        stdio: "ignore",
      });
    } catch {
      // Best effort on the way out. A serve we could not stop is a stray
      // process, not a reason to block the app from quitting.
    }
  }

  stop(projectPath) {
    const session = this.#sessions.get(projectPath);
    if (!session) return false;

    this.#sessions.delete(projectPath);
    if (session.adopted) {
      this.#stopAdopted(session);
    } else {
      session.child?.kill();
    }
    return true;
  }

  stopAll() {
    for (const projectPath of [...this.#sessions.keys()]) this.stop(projectPath);
  }
}

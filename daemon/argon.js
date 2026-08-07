// Lifecycle for the vendored `argon serve` process, one per project.
//
// Argon is a black box here: we start it, wait for its port to answer, and stop
// it. Nothing in MuslimSync reaches into how it syncs.
//
// `spawn` and `probe` are injectable so the state machine — port allocation,
// readiness, crash-before-ready, double start, stop — is testable without
// launching real processes.

import { spawn as nodeSpawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BASE_PORT = 8000;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 150;

/** The vendored binary for this platform, or null when unsupported. */
export function vendoredArgon() {
  const platform = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    win32: { x64: "windows-x86_64" },
    linux: { x64: "linux-x86_64" },
  }[process.platform]?.[process.arch];

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

  async #launch(projectPath) {
    if (!this.binary) throw new Error(`no vendored argon for ${process.platform}/${process.arch}`);

    const port = await this.#freePort();

    const child = this.spawn(this.binary, ["serve", projectPath, "--port", String(port), "--yes"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
        throw new Error(`argon serve exited before it was ready (code ${exited.code ?? exited.signal})`);
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

  stop(projectPath) {
    const session = this.#sessions.get(projectPath);
    if (!session) return false;

    this.#sessions.delete(projectPath);
    session.child?.kill();
    return true;
  }

  stopAll() {
    for (const projectPath of [...this.#sessions.keys()]) this.stop(projectPath);
  }
}

// `msync doctor` — why isn't it working?
//
// Every failure this project has actually hit is in here: the app not running,
// Studio running a stale plugin, an argon serve orphaned by a force-quit, a
// projects root that moved, a command folder with a typo in its JSON. Each was
// a hunt the first time. None of them should be a hunt again.
//
// Every check says what to do, not just what is wrong — a diagnosis you cannot
// act on is just a different way of being stuck.

import { existsSync, accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import { vendoredArgon } from "../daemon/argon.js";
import { explainUnreachable } from "./reach.js";
import { discover } from "../daemon/commands.js";

const PROTOCOL = 1;

/** ok: working. warn: works, but you should know. fail: this is your problem. */
const ok = (name, detail) => ({ level: "ok", name, detail });
const warn = (name, detail, fix) => ({ level: "warn", name, detail, fix });
const fail = (name, detail, fix) => ({ level: "fail", name, detail, fix });

async function checkDaemon(port) {
  let response;

  try {
    response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
  } catch (cause) {
    const blocked = ["EPERM", "EACCES"].includes(cause?.cause?.code);

    return {
      health: null,
      result: fail(
        "daemon",
        explainUnreachable(cause, port),
        // A blocked connection is not fixed by starting anything.
        blocked ? "allow loopback in the sandbox, or run from an unsandboxed shell" : "start the MuslimSync app, or `npm start`",
      ),
    };
  }

  const health = await response.json().catch(() => null);

  if (!health) {
    return { health: null, result: fail("daemon", `port ${port} answered with something that is not health`) };
  }

  // Which door answered matters now: a sandboxed shell reaches the socket and
  // not the port, and knowing which one worked is the whole diagnosis.
  const via = health.socket ? `unix socket (${health.socket})` : `port ${port}`;

  return { health, result: ok("daemon", `answering over ${via}`) };
}

/** Whether Roblox Studio is running at all. Unknown on platforms without pgrep. */
function studioIsRunning() {
  try {
    execFileSync("pgrep", ["-x", "RobloxStudio"], { stdio: "ignore" });
    return true;
  } catch (error) {
    // pgrep exits 1 when nothing matched, and ENOENT when it does not exist.
    return error.code === "ENOENT" ? null : false;
  }
}

function checkPlugin(health) {
  const plugins = health?.plugins ?? [];

  if (!plugins.length) {
    const running = studioIsRunning();

    // "The plugin is not installed" and "Studio is not open" and "Studio is
    // open on the start page" are three different situations with three
    // different fixes, and one sentence covering all of them helps with none.
    const fix =
      running === false
        ? "Studio is not running — open it, then open a place"
        : running === true
          ? "Studio is running but no place is open; the plugin needs a DataModel to attach to. Open a place — if one is already open, the plugin may not be installed: `npm run build:plugin -- --install`, then restart Studio"
          : "open a place in Studio; if one is already open, the plugin may not be installed — `npm run build:plugin -- --install` then restart Studio";

    return [fail("plugin", "no Studio place is connected", fix)];
  }

  const results = plugins.map((plugin) => {
    const name = plugin.placeName ?? `place ${plugin.placeId}`;
    return ok("plugin", `${name} — v${plugin.pluginVersion}, ${plugin.pending} pending`);
  });

  if (health.protocol !== PROTOCOL) {
    results.push(
      fail(
        "protocol",
        `daemon speaks ${PROTOCOL}, this build expects ${health.protocol}`,
        "rebuild the plugin and restart Studio",
      ),
    );
  }

  return results;
}

function checkArgon() {
  const binary = vendoredArgon();

  if (!binary) {
    return fail(
      "argon",
      `no binary vendored for ${process.platform}/${process.arch}`,
      "download an argon release into vendor/argon/",
    );
  }

  try {
    accessSync(binary, constants.X_OK);
  } catch {
    return fail("argon", `${binary} is not executable`, `chmod +x ${binary}`);
  }

  // Relative only when that is actually shorter and stays inside the tree:
  // run from elsewhere, `path.relative` produces ../../Users/... which is
  // longer than the truth and reads like the binary is somewhere odd.
  const relative = path.relative(process.cwd(), binary);

  return ok("argon", relative.startsWith("..") ? binary : relative);
}

/**
 * Serves argon believes are running.
 *
 * A force-quit app leaves its child alive, and argon then refuses to start a
 * second serve for that project. It is adopted automatically now, but a serve
 * whose process is gone is a stale entry that is worth naming.
 */
function checkSessions() {
  const file = path.join(homedir(), ".argon", "sessions.toml");

  if (!existsSync(file)) return ok("argon sessions", "none");

  const text = readFileSync(file, "utf8");
  const pids = [...text.matchAll(/pid\s*=\s*(\d+)/g)].map((match) => Number(match[1]));

  if (!pids.length) return ok("argon sessions", "none");

  const dead = pids.filter((pid) => {
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });

  if (dead.length) {
    return warn(
      "argon sessions",
      `${dead.length} of ${pids.length} refer to processes that are gone`,
      "`argon stop --all` clears them; a stale entry can make a serve look busy",
    );
  }

  return ok("argon sessions", `${pids.length} running`);
}

function checkProjectsRoot(root) {
  if (!root) return warn("projects root", "not set", "choose one in Settings");

  if (!existsSync(root)) {
    return fail("projects root", `${root} does not exist`, "pick another in Settings → Sync");
  }

  if (!statSync(root).isDirectory()) {
    return fail("projects root", `${root} is not a directory`, "pick another in Settings → Sync");
  }

  try {
    accessSync(root, constants.W_OK);
  } catch {
    return fail("projects root", `${root} is not writable`, "check its permissions");
  }

  return ok("projects root", root);
}

function checkCommands(appRoot) {
  const { commands, problems } = discover({ project: process.cwd(), appRoot });

  if (problems.length) {
    return [
      warn("commands", `${commands.length} loaded, ${problems.length} could not be`, problems[0]),
    ];
  }

  return [ok("commands", `${commands.length} loaded`)];
}

/**
 * Runs every check.
 *
 * `op` is passed in rather than imported so this stays testable without a
 * daemon; the capture check is skipped when there is nothing to ask.
 */
export async function diagnose({ port, projectsRoot, appRoot, op }) {
  const results = [];

  const { health, result } = await checkDaemon(port);
  results.push(result);

  if (health) results.push(...checkPlugin(health));

  results.push(checkArgon());
  results.push(checkSessions());
  results.push(checkProjectsRoot(projectsRoot));
  results.push(...checkCommands(appRoot));

  if (health?.plugins?.length && op) {
    const status = await op("capture_status", {}).catch(() => null);

    results.push(
      status?.available
        ? ok("capture", "CaptureScreenshot is available")
        : warn("capture", "this Studio build has no CaptureScreenshot", "photo and isolate will not work"),
    );
  }

  return results;
}

const MARK = { ok: "✓", warn: "!", fail: "✗" };

/** Renders the report. Fixes are indented under the line they belong to. */
export function formatReport(results, { green, cyan, red, dim }) {
  const colour = { ok: green, warn: cyan, fail: red };
  const width = Math.max(...results.map((result) => result.name.length));
  const lines = [];

  for (const result of results) {
    lines.push(`${colour[result.level](MARK[result.level])} ${result.name.padEnd(width)}  ${result.detail}`);
    if (result.fix) lines.push(`  ${" ".repeat(width)}  ${dim(`→ ${result.fix}`)}`);
  }

  const failed = results.filter((result) => result.level === "fail").length;
  const warned = results.filter((result) => result.level === "warn").length;

  lines.push("");
  lines.push(
    failed
      ? red(`${failed} problem${failed === 1 ? "" : "s"} to fix`)
      : warned
        ? cyan(`no problems, ${warned} thing${warned === 1 ? "" : "s"} to know about`)
        : green("everything checks out"),
  );

  return lines.join("\n");
}

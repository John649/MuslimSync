// Every command, against a real Studio.
//
// The unit tests cover the parts that can be reasoned about offline: argument
// binding, path confinement, the alpha solve's inputs. They cannot tell you
// that an op still exists in the plugin, that a Roblox API did not change under
// you, or that a command that "returns" actually did the thing. Only a live
// place can.
//
// Everything is built inside one scratch folder and destroyed at the end, so
// running this against a place you care about changes nothing in it.
//
//   node scripts/smoke.mjs            # every command
//   node scripts/smoke.mjs --quick    # skip playtests and captures
//
// Exits non-zero if anything failed, so it can gate a release.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MSYNC = path.join(ROOT, "cli", "msync.js");
const ROOM = "Workspace/MSyncSmoke";

const quick = process.argv.includes("--quick");
const scratch = mkdtempSync(path.join(tmpdir(), "msync-smoke-"));

const results = [];

/** Runs one msync invocation and records what happened. */
function msync(args, { expect = 0, label = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(process.execPath, [MSYNC, ...args], { timeout: 180000 }, (error, stdout, stderr) => {
      const code = error?.code ?? 0;
      const ms = Date.now() - startedAt;
      const ok = code === expect;

      results.push({
        label: label ?? args[0],
        command: `msync ${args.join(" ")}`,
        ok,
        code,
        ms,
        // Only the tail: a failure explains itself in its last line, and a full
        // tree dump would bury every other result.
        detail: ok ? "" : (stderr || stdout).trim().split("\n").slice(-2).join(" ").slice(0, 160),
      });

      resolve({ ok, stdout, stderr, code });
    });
  });
}

const step = (name) => console.log(`\n— ${name}`);

async function main() {
  // ------------------------------------------------------------- info
  step("info");
  await msync(["status"]);
  await msync(["capabilities"]);
  await msync(["commands", "--raw"]);
  await msync(["help"]);
  await msync(["help", "photo"], { label: "help <command>" });
  await msync(["help", "capture"], { label: "help <group>" });
  await msync(["agents"]);
  await msync(["agents", "--only", "navigate"], { label: "agents --only" });
  await msync(["agents", "--install", scratch], { label: "agents --install" });
  await msync(["projects"]);
  await msync(["verse"]);
  await msync(["ping"]);

  // Usage errors must be usage errors, not crashes.
  await msync(["agents", "--only", "nonsense"], { expect: 2, label: "agents --only (bad)" });
  await msync(["nosuchcommand"], { expect: 2, label: "unknown command" });

  // -------------------------------------------------------- navigate
  step("navigate");
  await msync(["ls", "Workspace"]);
  await msync(["ls"], { label: "ls (root)" });
  await msync(["tree", "Workspace", "--depth", "2"]);
  await msync(["get", "Workspace"]);
  await msync(["props", "Workspace/Camera"]);
  await msync(["query", "Workspace/**/Camera"]);
  await msync(["find", "--class", "Camera"]);
  await msync(["get", "Workspace/DefinitelyNotHere"], { expect: 4, label: "get (missing)" });

  // ----------------------------------------------------------- write
  step("write");
  await msync(["new", "Folder", "--parent", "Workspace", "--name", "MSyncSmoke"]);
  await msync(["new", "Part", "--parent", ROOM, "--name", "Block"]);
  await msync(["set", `${ROOM}/Block`, "Position", "0,150,0"], { label: "set (Vector3 string)" });
  await msync(["set", `${ROOM}/Block`, "Color", "255,128,0"], { label: "set (Color3 rgb)" });
  await msync(["set", `${ROOM}/Block`, "Color", "#3b82f6"], { label: "set (Color3 hex)" });
  await msync(["set", `${ROOM}/Block`, "Material", "Neon"], { label: "set (enum by name)" });
  await msync(["set", `${ROOM}/Block`, "Anchored", "true"], { label: "set (boolean)" });
  await msync(["set", `${ROOM}/Block`, "Parent", "Lighting"], { expect: 4, label: "set Parent (refused)" });
  await msync(["attr", `${ROOM}/Block`, "set", "smoke", "yes"]);
  await msync(["attr", `${ROOM}/Block`], { label: "attr ls" });
  await msync(["tag", `${ROOM}/Block`, "add", "smoke-tag"]);
  await msync(["tag", `${ROOM}/Block`], { label: "tag ls" });
  await msync(["select", `${ROOM}/Block`]);
  await msync(["select"], { label: "select (read)" });
  await msync(["new", "Folder", "--parent", ROOM, "--name", "Nested"]);
  await msync(["mv", `${ROOM}/Block`, `${ROOM}/Nested`]);
  await msync(["mv", `${ROOM}/Nested/Block`, ROOM], { label: "mv (back)" });

  // ---------------------------------------------------------- studio
  step("studio");
  await msync(["eval", "return 6 * 7"]);
  await msync(["eval", "return { a = 1, b = { c = 2 } }"], { label: "eval (table)" });
  await msync(["eval", "error('deliberate')"], { expect: 4, label: "eval (error)" });
  await msync(["logs"]);
  await msync(["undo"]);
  await msync(["redo"]);
  await msync(["source", `${ROOM}/Script`], { expect: 4, label: "source (missing)" });

  // A real script, so `source` has something true to read.
  await msync(["new", "Script", "--parent", ROOM, "--name", "Probe"]);
  await msync(["source", `${ROOM}/Probe`]);

  // -------------------------------------------------------- transfer
  step("transfer");
  await msync(["copy", `${ROOM}/Block`]);
  await msync(["paste", ROOM]);

  // --------------------------------------------------------- capture
  if (!quick) {
    step("capture");
    await msync(["authorize"]);
    await msync(["photo", "--out", path.join(scratch, "viewport.png")]);
    await msync(["photo", "--subject", `${ROOM}/Block`, "--out", path.join(scratch, "framed.png")], {
      label: "photo --subject",
    });
    await msync(
      ["photo", "--subject", `${ROOM}/Block`, "--isolate", "--out", path.join(scratch, "isolated.png")],
      { label: "photo --isolate" },
    );

    // -------------------------------------------------------- playtest
    step("playtest");
    await msync(["playing"], { label: "playing (before)" });
    await msync(["playtest"]);
    await msync(["run", "return #game.Players:GetPlayers()"], { label: "run (server)" });
    await msync(["run", "--context", "client", "return 1"], { label: "run (client)" });
    await msync(["stop"]);
  }

  // ------------------------------------------------------- custom
  step("custom commands");
  await msync(["anchor-all", "--path", ROOM, "--dryRun", "true"], { label: "custom (luau)" });
  await msync(["camera-marker", "--name", "SmokeMarker"], { label: "custom (workflow)" });
  await msync(["rm", "Workspace/SmokeMarker"], { label: "cleanup marker" });

  // ------------------------------------------------------- teardown
  step("teardown");
  await msync(["rm", ROOM]);
}

try {
  await main();
} finally {
  // Best effort: a failure mid-run must not leave the room behind.
  await msync(["rm", ROOM], { label: "teardown (safety)" }).catch(() => {});
  results.pop();
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

console.log(`\n${"─".repeat(64)}`);
for (const result of failed) {
  console.log(`FAIL  ${result.label.padEnd(24)} exit ${result.code}  ${result.detail}`);
}

console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log("\nslowest:");
for (const result of slowest) console.log(`  ${String(result.ms).padStart(6)}ms  ${result.label}`);

process.exit(failed.length ? 1 : 0);

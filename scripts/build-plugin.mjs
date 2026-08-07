// Builds plugin/ into dist/MuslimSync.rbxm using the vendored argon binary.
//
// Uses the vendored binary rather than whatever `argon` is on PATH: the plugin
// and the sync server have to agree on a version (Core/init.luau refuses to
// sync on a major.minor mismatch), so the build must not depend on the
// developer's global install.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORM = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  win32: { x64: "windows-x86_64" },
  linux: { x64: "linux-x86_64" },
}[process.platform]?.[process.arch];

if (!PLATFORM) {
  console.error(`no vendored argon for ${process.platform}/${process.arch}`);
  process.exit(1);
}

const binary = path.join(ROOT, "vendor", "argon", PLATFORM, process.platform === "win32" ? "argon.exe" : "argon");

if (!existsSync(binary)) {
  console.error(`missing vendored argon binary: ${binary}`);
  process.exit(1);
}

// --install writes straight into Studio's plugins folder instead of dist/, and
// --watch rebuilds on every save.
//
// Measured, not assumed. Studio does NOT hot-reload a local plugin into an
// already-open place: a rebuild at 19:53 left the plugin that connected at
// 19:52 still running a minute later with no reconnect.
//
// But plugins load per-DataModel, so Cmd+N for a new place picks up the latest
// build immediately — no Studio restart needed. The loop is: save, then Cmd+N.
// Verified by watching a layout fix appear in a new place while the old one
// kept running the previous build.
const install = process.argv.includes("--install");
const watch = process.argv.includes("--watch");

const args = ["build", "--yes"];

if (install) {
  args.push("--plugin");
} else {
  const output = path.join(ROOT, "dist", "MuslimSync.rbxm");
  mkdirSync(path.dirname(output), { recursive: true });
  args.push("--output", output);
}

if (watch) args.push("--watch");

const result = spawnSync(binary, args, {
  cwd: path.join(ROOT, "plugin"),
  stdio: "inherit",
});

process.exit(result.status ?? 1);

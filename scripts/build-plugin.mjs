// Builds plugin/ into dist/MuslimSync.rbxm using the vendored argon binary.
//
// Uses the vendored binary rather than whatever `argon` is on PATH: the plugin
// and the sync server have to agree on a version (Core/init.luau refuses to
// sync on a major.minor mismatch), so the build must not depend on the
// developer's global install.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
/**
 * Bakes the Argon auth token into the build.
 *
 * The fork's argon server rejects every mutating request without a matching
 * x-argon-token, so a plugin built without one connects and is immediately
 * disconnected with HTTP 401. The token lives in ~/.argon/auth.token and is
 * written to src/AuthToken.luau, which is gitignored — the secret is embedded
 * at build time and never committed.
 *
 * Missing token is a warning, not an error: a build for someone who has not run
 * argon yet is still useful, and the AuthToken setting in the plugin remains an
 * override.
 */
function embedAuthToken() {
  const source = path.join(homedir(), ".argon", "auth.token");
  const target = path.join(ROOT, "plugin", "src", "AuthToken.luau");

  if (!existsSync(source)) {
    console.warn(`no ${source} — building without an embedded auth token; argon will reject writes with 401`);
    return;
  }

  const token = readFileSync(source, "utf8").trim();

  if (!/^[0-9a-f]{8,}$/i.test(token)) {
    console.warn(`${source} does not look like a token; skipping`);
    return;
  }

  writeFileSync(target, `-- Generated at build time from ~/.argon/auth.token. Gitignored.\nreturn ${JSON.stringify(token)}\n`);
}

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

embedAuthToken();

const result = spawnSync(binary, args, {
  cwd: path.join(ROOT, "plugin"),
  stdio: "inherit",
});

process.exit(result.status ?? 1);

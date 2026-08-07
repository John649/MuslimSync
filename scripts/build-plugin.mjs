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

const output = path.join(ROOT, "dist", "MuslimSync.rbxm");
mkdirSync(path.dirname(output), { recursive: true });

const result = spawnSync(binary, ["build", "--output", output, "--yes"], {
  cwd: path.join(ROOT, "plugin"),
  stdio: "inherit",
});

process.exit(result.status ?? 1);

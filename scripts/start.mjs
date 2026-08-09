// `npm start`.
//
// Running `electron .` launches Electron's own bundle, so macOS takes the Dock
// name, the icon and the menu bar title from it and the app introduces itself
// as "Electron". That is not a thing package.json can override — the bundle is
// what macOS reads.
//
// So on macOS this launches the real bundle, building it first if it is missing
// or older than the app source. Windows has the same problem for the taskbar and
// the Start menu, so it gets the same treatment through make-shortcut.mjs.
// Elsewhere there is nothing to build and `electron .` is already correct.
//
// `npm run start:dev` is the raw form, for when stdout in the terminal matters
// more than the name in the Dock.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "MuslimSync.app");

function electronDirectly() {
  // The electron package's main export is the absolute path to the binary for
  // this platform. `node_modules/.bin/electron` is not: it is a shell script
  // Windows cannot execute, and its .cmd twin is refused by Node's spawn.
  const electron = createRequire(import.meta.url)("electron");
  spawn(electron, [ROOT, ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) =>
    process.exit(code ?? 0),
  );
}

if (process.platform === "win32") {
  // Windows has no bundle to build, but it does need an identity: without a
  // Start-menu shortcut carrying the icon and the AppUserModelID, the taskbar
  // shows electron.exe. make-shortcut is a no-op once both exist, so it runs on
  // every start the way the mac path maintains its bundle.
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-shortcut.mjs"), "--quiet"], {
      stdio: "inherit",
    });
  } catch {
    // A Start menu we cannot write to is not a reason to refuse to launch.
  }

  electronDirectly();
} else if (process.platform !== "darwin") {
  electronDirectly();
} else {
  // The launcher inside the bundle bakes in this checkout's path, so a bundle
  // built from a different location would silently run the wrong code.
  const stale =
    !existsSync(BUNDLE) ||
    !readdirSync(path.join(ROOT, "app"))
      .map((entry) => statSync(path.join(ROOT, "app", entry)).mtimeMs)
      .every((at) => at < statSync(BUNDLE).mtimeMs);

  if (stale) {
    console.log("building the app bundle...");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-app.mjs")], { stdio: "inherit" });
  }

  execFileSync("open", [BUNDLE]);
  console.log("MuslimSync is running. Logs: npm run start:dev");
}

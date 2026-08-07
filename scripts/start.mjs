// `npm start`.
//
// Running `electron .` launches Electron's own bundle, so macOS takes the Dock
// name, the icon and the menu bar title from it and the app introduces itself
// as "Electron". That is not a thing package.json can override — the bundle is
// what macOS reads.
//
// So on macOS this launches the real bundle, building it first if it is missing
// or older than the app source. Everywhere else there is no bundle to build and
// `electron .` is already correct.
//
// `npm run start:dev` is the raw form, for when stdout in the terminal matters
// more than the name in the Dock.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "MuslimSync.app");

function electronDirectly() {
  const electron = path.join(ROOT, "node_modules", ".bin", "electron");
  spawn(electron, [ROOT, ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) =>
    process.exit(code ?? 0),
  );
}

if (process.platform !== "darwin") {
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

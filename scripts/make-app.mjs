// Builds dist/MuslimSync.app.
//
// `npm start` runs Electron's own bundle, so macOS reads the Dock name, the
// icon, and the menu bar title out of Electron.app's Info.plist — which is why
// the app introduces itself as "Electron".
//
// The fix is a real bundle, but not a packaged one: this copies Electron's
// bundle, renames it, and drops in a launcher that points back at this repo.
// The code is never copied, so editing app/ takes effect on the next launch
// with nothing to rebuild — which is the "simple shortcut to run a js/electron
// app" this project asked for, rather than a distributable.
//
// Nothing is compiled. It is a folder with a plist in it.

import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "Electron.app");
const OUT = path.join(ROOT, "dist", "MuslimSync.app");

const NAME = "MuslimSync";
const IDENTIFIER = "com.muslimsync.app";

if (process.platform !== "darwin") {
  // The bundle layout, the plist, and iconutil are all macOS. Saying so beats
  // producing something shaped like an app that cannot run.
  console.error("make-app builds a macOS .app bundle; on Windows or Linux, run `npm start`.");
  process.exit(1);
}

if (!existsSync(ELECTRON)) {
  console.error(`no Electron at ${ELECTRON} — run npm install first.`);
  process.exit(1);
}

/** Renders the 512px logo into the iconset macOS wants. */
function buildIcon(resources) {
  const source = path.join(ROOT, "assets", "Logo.png");

  if (!existsSync(source)) {
    console.warn("assets/Logo.png is missing; the bundle keeps Electron's icon.");
    return null;
  }

  const work = mkdtempSync(path.join(tmpdir(), "muslimsync-icon-"));
  const iconset = path.join(work, `${NAME}.iconset`);
  mkdirSync(iconset);

  // The sizes macOS actually asks for. Retina variants are the same pixels at
  // double the nominal size, which is why each appears twice.
  for (const [size, name] of [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
  ]) {
    execFileSync("sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, name)], {
      stdio: "ignore",
    });
  }

  const icns = path.join(resources, `${NAME}.icns`);
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
  rmSync(work, { recursive: true, force: true });

  return `${NAME}.icns`;
}

const plist = (file, key, value) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, file], { stdio: "ignore" });

console.log(`building ${path.relative(ROOT, OUT)}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.dirname(OUT), { recursive: true });
cpSync(ELECTRON, OUT, { recursive: true, verbatimSymlinks: true });

const contents = path.join(OUT, "Contents");
const resources = path.join(contents, "Resources");

// The executable's filename is what shows in Activity Monitor and in the
// force-quit list, so it is renamed too rather than left as "Electron".
renameSync(path.join(contents, "MacOS", "Electron"), path.join(contents, "MacOS", NAME));

const icon = buildIcon(resources);
const info = path.join(contents, "Info.plist");

plist(info, "CFBundleName", NAME);
plist(info, "CFBundleDisplayName", NAME);
plist(info, "CFBundleExecutable", NAME);
plist(info, "CFBundleIdentifier", IDENTIFIER);
if (icon) plist(info, "CFBundleIconFile", icon);

// The launcher. Electron loads Contents/Resources/app, and this one does
// nothing but hand over to the repo — so the bundle stays a pointer and the
// source of truth stays in git.
const app = path.join(resources, "app");
mkdirSync(app, { recursive: true });

writeFileSync(
  path.join(app, "package.json"),
  `${JSON.stringify({ name: "muslimsync", productName: NAME, main: "launch.cjs" }, null, 2)}\n`,
);

writeFileSync(
  path.join(app, "launch.cjs"),
  [
    "// Hands over to the checked-out repo, so edits take effect on next launch",
    "// with nothing to rebuild. The path is baked in at build time because the",
    "// bundle is a shortcut to this machine's copy, not a distributable.",
    `const { app } = require("electron");`,
    "",
    `app.setName(${JSON.stringify(NAME)});`,
    "",
    `import(${JSON.stringify(`file://${path.join(ROOT, "app", "main.js")}`)}).catch((error) => {`,
    "  console.error(error);",
    "  app.quit();",
    "});",
    "",
  ].join("\n"),
);

console.log(`  name       ${NAME}`);
console.log(`  icon       ${icon ?? "Electron's (no assets/Logo.png)"}`);
console.log(`  runs       ${path.join(ROOT, "app", "main.js")}`);
console.log("\nOpen it, or drag it to the Dock or Applications.");

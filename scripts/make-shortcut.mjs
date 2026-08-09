// Gives MuslimSync a Windows app identity: an icon, a Start-menu entry, and an
// AppUserModelID tying the two to the running window.
//
// `npm start` launches node_modules/electron/dist/electron.exe, so Windows has
// nothing of ours to show. The taskbar gets the Electron atom, the Start menu
// has no entry at all, and pinning the running window pins electron.exe — which
// relaunches an empty shell rather than this app.
//
// This is the win32 sibling of make-app.mjs and works on the same idea: not a
// packaged app, a shortcut pointing back at this checkout, so editing app/ takes
// effect on the next launch with nothing to rebuild.
//
// Nothing is compiled. It is a .lnk and an .ico.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIco, readIcoEntries } from "./ico.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO = path.join(ROOT, "assets", "Logo.png");
const ICO = path.join(ROOT, "assets", "muslimsync.ico");

const NAME = "MuslimSync";
const DESCRIPTION = "Roblox Studio sync, control, and agent tooling.";

// Must stay identical to app/main.js's setAppUserModelId. Windows matches a
// running window to a shortcut by this string; when they disagree, pinning the
// window pins electron.exe instead of this app.
const APP_ID = "com.muslimsync.app";

const PROPERTY_STORE_BLOCK = 0xa0000009;
const STORAGE_VERSION = 0x53505331; // "1PSP"

// {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, the AppUserModel property set, in the
// little-endian layout .lnk files store format ids in. Property 5 is the id.
const APP_USER_MODEL = Buffer.from("55284c9f799f394ba8d0e1d42de1d5f3", "hex");

const quiet = process.argv.includes("--quiet");
const force = process.argv.includes("--force");

if (process.platform !== "win32") {
  // Start menus, .lnk files and .ico files are all Windows. Saying so beats
  // producing something shaped like a shortcut that nothing can open.
  console.error("make-shortcut builds a Windows Start-menu entry; on macOS run `npm run make:app`.");
  process.exit(1);
}

if (!process.env.APPDATA) {
  console.error("APPDATA is not set, so there is no Start menu to write to.");
  process.exit(1);
}

const LNK = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${NAME}.lnk`);

/** A PowerShell single-quoted literal; the only escape inside one is ''. */
const literal = (value) => `'${value.replace(/'/g, "''")}'`;

const powershell = (lines) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", lines.join("\n")], {
    encoding: "utf8",
  });

/** Offset of the shortcut's property store block, or -1. */
function findPropertyStore(lnk) {
  for (let at = 4; at + 8 <= lnk.length; at += 1) {
    if (lnk.readUInt32LE(at) !== PROPERTY_STORE_BLOCK) continue;

    // Confirm the candidate rather than trust a four-byte coincidence: the block
    // has to fit inside the file and open with a serialized storage.
    const start = at - 4;
    const size = lnk.readUInt32LE(start);

    if (size >= 16 && start + size <= lnk.length && lnk.readUInt32LE(start + 12) === STORAGE_VERSION) return start;
  }

  return -1;
}

/** One serialized property storage holding the app id as a VT_BSTR string. */
function storage(id) {
  const text = Buffer.from(`${id}\0`, "utf16le");

  // A property value is its own size, the property id, a reserved byte, then a
  // typed value: VT_BSTR, two bytes of padding, and a byte count that includes
  // the terminator. This is the shape Windows itself writes.
  const value = Buffer.alloc(17 + text.length);
  value.writeUInt32LE(value.length, 0);
  value.writeUInt32LE(5, 4);
  value.writeUInt16LE(0x0008, 9);
  value.writeUInt32LE(text.length, 13);
  text.copy(value, 17);

  const out = Buffer.alloc(28 + value.length);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(STORAGE_VERSION, 4);
  APP_USER_MODEL.copy(out, 8);
  value.copy(out, 24);

  return out;
}

/** Splits a property store into its storages, dropping any app id already set. */
function otherStorages(store) {
  const kept = [];

  for (let at = 0; at + 28 <= store.length; ) {
    const size = store.readUInt32LE(at);
    if (size < 28) break; // a zero size terminates the list

    // Re-running must not stack duplicates, so an id we wrote before is dropped.
    if (!store.subarray(at + 8, at + 24).equals(APP_USER_MODEL)) kept.push(store.subarray(at, at + size));
    at += size;
  }

  return kept;
}

/**
 * Writes System.AppUserModel.ID onto a shortcut.
 *
 * WScript.Shell sets every field of a .lnk except this one, and there is no
 * scriptable API for it — the documented route is COM (IShellLink plus
 * IPropertyStore), which from here means compiling C# at runtime. The file
 * format is published and the block is under a hundred bytes, so this edits the
 * bytes instead: a property store is a list of storages ending in a zero size,
 * and ours goes in ahead of that terminator.
 */
function writeAppId(file, id) {
  const lnk = readFileSync(file);
  const at = findPropertyStore(lnk);
  const size = at < 0 ? 0 : lnk.readUInt32LE(at);

  const store = Buffer.concat([
    ...(at < 0 ? [] : otherStorages(lnk.subarray(at + 8, at + size - 4))),
    storage(id),
    Buffer.alloc(4),
  ]);

  const block = Buffer.alloc(8 + store.length);
  block.writeUInt32LE(block.length, 0);
  block.writeUInt32LE(PROPERTY_STORE_BLOCK, 4);
  store.copy(block, 8);

  // With no store to extend, the block is appended ahead of the four zero bytes
  // that end the shortcut's extra data.
  const before = at < 0 ? lnk.subarray(0, lnk.length - 4) : lnk.subarray(0, at);
  const after = at < 0 ? lnk.subarray(lnk.length - 4) : lnk.subarray(at + size);

  writeFileSync(file, Buffer.concat([before, block, after]));
}

/** Reads the app id back out of a shortcut, to prove it stuck. */
function readAppId(file) {
  const lnk = readFileSync(file);
  const at = findPropertyStore(lnk);
  if (at < 0) return null;

  const store = lnk.subarray(at + 8, at + lnk.readUInt32LE(at));

  for (let o = 0; o + 28 <= store.length; ) {
    const size = store.readUInt32LE(o);
    if (size < 28) break;

    if (store.subarray(o + 8, o + 24).equals(APP_USER_MODEL)) {
      // Only the VT_BSTR form we write is understood here.
      const bytes = store.readUInt32LE(o + 37);
      return store.subarray(o + 41, o + 41 + bytes - 2).toString("utf16le");
    }

    o += size;
  }

  return null;
}

function createShortcut(electron) {
  powershell([
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${literal(LNK)})`,
    `$link.TargetPath = ${literal(electron)}`,
    // Electron's own argv: the app to run is this checkout, which is what keeps
    // the shortcut a pointer rather than a copy.
    `$link.Arguments = ${literal(`"${ROOT}"`)}`,
    `$link.WorkingDirectory = ${literal(ROOT)}`,
    `$link.IconLocation = ${literal(`${ICO},0`)}`,
    `$link.Description = ${literal(DESCRIPTION)}`,
    "$link.Save()",
  ]);
}

function readShortcut() {
  const out = powershell([
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${literal(LNK)})`,
    '"target=" + $link.TargetPath',
    '"arguments=" + $link.Arguments',
    '"workingDirectory=" + $link.WorkingDirectory',
    '"icon=" + $link.IconLocation',
    '"description=" + $link.Description',
  ]);

  return Object.fromEntries(
    out
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

let electron = null;

try {
  // The electron package's main export is the absolute path to this platform's
  // binary, which is what the shortcut has to point at.
  electron = createRequire(import.meta.url)("electron");
} catch {
  // Treated below as the same problem as a binary that is not there.
}

if (!electron || !existsSync(electron)) {
  console.error("no Electron in node_modules — run npm install first.");
  process.exit(1);
}

const iconStale = force || !existsSync(ICO) || statSync(LOGO).mtimeMs > statSync(ICO).mtimeMs;

if (iconStale) {
  if (!existsSync(LOGO)) {
    console.error(`no ${path.relative(ROOT, LOGO)} — run \`npm run make:icons\` first.`);
    process.exit(1);
  }

  writeFileSync(ICO, buildIco(readFileSync(LOGO)));
}

// The shortcut is rebuilt whenever the icon was, so a regenerated logo reaches
// the Start menu without anyone having to remember this step.
const shortcutStale = force || iconStale || !existsSync(LNK);

if (shortcutStale) {
  createShortcut(electron);
  writeAppId(LNK, APP_ID);
}

// `npm start` runs this every time, and saying nothing when there was nothing to
// do keeps that quiet.
if (quiet && !shortcutStale) process.exit(0);

const fields = readShortcut();
const sizes = readIcoEntries(readFileSync(ICO)).map(
  (entry) => `${entry.width}${entry.encoding === "png" ? " (png)" : ""}`,
);

console.log(`${shortcutStale ? "wrote" : "found"} ${LNK}`);
console.log(`  target     ${fields.target}`);
console.log(`  arguments  ${fields.arguments}`);
console.log(`  workdir    ${fields.workingDirectory}`);
console.log(`  icon       ${fields.icon}  (${sizes.join(", ")})`);
console.log(`  appId      ${readAppId(LNK) ?? "not set"}`);
console.log("\nPin it from the Start menu: search MuslimSync, right-click, Pin to taskbar.");

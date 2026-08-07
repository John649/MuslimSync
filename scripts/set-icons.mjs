// Writes uploaded brand asset ids into the plugin's Assets.json.
//
// A Studio toolbar button can only use an uploaded asset — a plugin cannot
// reference a local file — and uploading happens on your Roblox account, so it
// is the one step this repo cannot do for you. `npm run make:icons` produces
// the PNGs; this takes the ids you get back.
//
//   npm run set:icons -- 123 456 789 012      (logo, ok, warn, error)
//   npm run set:icons -- 123                  (one id for all four states)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "plugin", "src", "App", "Assets.json");

const ids = process.argv.slice(2).map((value) => value.replace(/^rbxassetid:\/\//, "").trim());

if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) {
  console.error("usage: npm run set:icons -- <logo> [ok] [warn] [error]");
  console.error("       ids are the numbers Roblox gives you after uploading assets/*.png");
  process.exit(2);
}

const [logo, ok = logo, warn = logo, error = logo] = ids;
const assets = JSON.parse(readFileSync(FILE, "utf8"));

assets.Brand = {
  Logo: `rbxassetid://${logo}`,
  LogoOk: `rbxassetid://${ok}`,
  LogoWarn: `rbxassetid://${warn}`,
  LogoError: `rbxassetid://${error}`,
};

delete assets._note;
writeFileSync(FILE, `${JSON.stringify(assets, null, 2)}\n`);

console.log("brand icons set. Rebuild and restart Studio:");
console.log("  npm run build:plugin -- --install");

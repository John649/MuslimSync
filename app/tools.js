// The commands, capture and playtest views.
//
// Every one of these runs the same op the CLI runs. One path in means the app
// cannot drift from the command line, or grow a second set of behaviours that
// have to be kept in step by hand.

import { clipboard, ipcMain } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { authoringBrief } from "../cli/scaffold.js";
import { COMMANDS } from "../cli/commands.js";
import { readConfig, writeDisabled, isEnabled } from "../cli/config.js";
import { discover, bindArgs, run as runCommand } from "../daemon/commands.js";
import { encodePng, alphaBounds, cropRgba } from "../daemon/png.js";
import { decodeValue } from "../cli/playtest.js";

/**
 * Pulls a capture's pixels out of the artifact store and writes a PNG.
 *
 * Paged and alpha-cropped exactly as the CLI does it: a capture taken from the
 * app and one taken from the terminal should be the same file.
 */
async function writeCapture(store, into, result, options) {
  const parts = [];
  let offset = 0;

  for (;;) {
    const page = store.read(result.artifact, { offset });
    if (page.error) throw new Error(page.error);

    parts.push(Buffer.from(page.dataBase64, "base64"));
    offset = page.nextOffset;

    if (page.eof) break;
  }

  let pixels = Buffer.concat(parts);
  let { width, height } = result;

  if (result.isolated && !result.cropped && options.tight !== false) {
    // Matched to the plugin's noise floor: a pixel the renderer already called
    // transparent must not drag the crop out to the frame edge.
    const bounds = alphaBounds(pixels, width, height, 4);
    if (!bounds) throw new Error("the render came back completely transparent");

    pixels = cropRgba(pixels, width, height, bounds);
    width = bounds.width;
    height = bounds.height;
  }

  mkdirSync(into, { recursive: true });

  const file = path.join(into, `capture-${Date.now()}.png`);
  writeFileSync(file, encodePng(pixels, width, height));

  return { file, width, height };
}

/**
 * Wires the tool views' IPC.
 *
 * `daemon` and `artifacts` are read through getters because both are replaced
 * when the daemon restarts, and a captured reference would keep answering from
 * the dead one.
 */
export function registerTools({ daemon, artifacts, appRoot, directory, record }) {
  const op = (name, args = {}, timeoutMs = 120000) => {
    const live = daemon();
    if (!live) throw new Error("the daemon is not running");
    return live.request(name, args, { timeoutMs });
  };

  // Re-read every time: a command folder can be dropped in while the app runs,
  // and the whole point of the format is that it takes effect without a build.
  const load = () => discover({ project: null, appRoot });

  ipcMain.handle("commands:list", () => {
    const { commands, problems } = load();

    return {
      commands: commands.map(({ name, description, category, kind, args }) => ({
        name,
        description,
        category,
        kind,
        args,
      })),
      problems,
    };
  });

  ipcMain.handle("commands:brief", () => authoringBrief());

  /**
   * Every built-in command and whether this project allows it.
   *
   * Editing JSON by hand to turn a command off is a chore nobody will do
   * twice, so the same file the CLI reads is what these toggles write.
   */
  ipcMain.handle("config:list", (_event, projectPath) => {
    const config = projectPath ? readConfig(projectPath) : { file: null, disable: [], only: null };

    return {
      file: config.file,
      // `only` is an allowlist someone wrote by hand; toggles cannot express it
      // without silently rewriting their intent, so the UI says so instead.
      allowlist: config.only,
      commands: Object.entries(COMMANDS).map(([name, spec]) => ({
        name,
        group: spec.group,
        summary: spec.summary,
        enabled: isEnabled(name, config),
        // Some commands are how you find out what went wrong; turning them off
        // would leave a project nobody can debug.
        locked: ["help", "doctor", "commands", "status"].includes(name),
      })),
    };
  });

  ipcMain.handle("config:set", (_event, projectPath, name, enabled) => {
    const config = readConfig(projectPath);
    const disable = new Set(config.disable);

    if (enabled) disable.delete(name);
    else disable.add(name);

    const written = writeDisabled(projectPath, [...disable]);
    record("op", `${name} ${enabled ? "enabled" : "disabled"} for ${path.basename(projectPath)}`);

    return written;
  });

  ipcMain.handle("commands:copyBrief", () => {
    clipboard.writeText(authoringBrief());
    return true;
  });

  ipcMain.handle("commands:run", async (_event, name, args) => {
    const command = load().commands.find((candidate) => candidate.name === name);
    if (!command) throw new Error(`no command named ${name}`);

    const value = await runCommand(command, { args: bindArgs(command, args ?? {}), ctx: { op } });
    record("op", `${name} — ran`);

    return value ?? null;
  });

  ipcMain.handle("capture:take", async (_event, options = {}) => {
    const args = {};
    if (options.subject) args.subject = options.subject;
    if (options.isolate) args.isolate = true;
    if (options.delay) args.delay = Number(options.delay);

    const result = await op("photo", args);
    const written = await writeCapture(artifacts(), path.join(directory(), "captures"), result, options);

    record("op", `photo — ${path.basename(written.file)}`);

    // A file:// url so the renderer can show it without the main process
    // shipping megabytes of base64 across the bridge.
    return { ...result, ...written, url: `file://${written.file}` };
  });

  ipcMain.handle("playtest:status", () => op("playtest_status", {}, 15000));

  ipcMain.handle("playtest:start", (_event, options = {}) => {
    const args = { mode: options.mode ?? "play" };
    if (options.players) args.players = Number(options.players);

    return op("playtest_start", args, 30000);
  });

  ipcMain.handle("playtest:stop", () => op("playtest_stop", {}, 30000));

  ipcMain.handle("playtest:run", async (_event, source, context) => {
    const result = await op("playtest_exec", { source, context: context ?? "server" }, 60000);

    // Decoded through the same function the CLI uses, so a table result reads
    // as an object here too rather than as "table: 0x...".
    return { ...result, value: decodeValue(result) };
  });
}

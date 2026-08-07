#!/usr/bin/env node
// msync — the command line for MuslimSync.
//
// Thin by design: it parses arguments, posts one op to the daemon, and renders
// the answer. All the intelligence lives in the daemon and the plugin, so the
// CLI, the app, and an agent all go through exactly the same path.

import { parse, bind, coerce, UsageError } from "./args.js";
import { COMMANDS, registry } from "./commands.js";
import { render, help, commandHelp, red, dim } from "./format.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, bindArgs, run as runCommand } from "../daemon/commands.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_PORT = 7900;

// Exit codes an agent or a script can branch on, rather than parsing prose.
const EXIT = {
  ok: 0,
  usage: 2,
  notConnected: 3,
  pluginError: 4,
  daemonDown: 5,
};

async function daemon(port, route, body) {
  let response;

  try {
    response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // A refused connection is the single most common failure, and "fetch
    // failed" tells the user nothing about what to do next.
    throw new Fatal(EXIT.daemonDown, `no MuslimSync daemon on port ${port}. Is the app running?`);
  }

  const payload = await response.json().catch(() => ({}));

  if (payload.ok) return payload.value;

  const error = payload.error ?? { code: "UNKNOWN", message: `HTTP ${response.status}` };
  const code = error.code === "NOT_CONNECTED" ? EXIT.notConnected : EXIT.pluginError;

  throw new Fatal(code, error.message, error.code);
}

class Fatal extends Error {
  constructor(exit, message, code) {
    super(message);
    this.exit = exit;
    this.code = code;
  }
}

/** Commands answered without touching the plugin. */
async function local(name, { flags, port }) {
  switch (name) {
    case "help":
      return { text: help() };

    case "commands":
      return { json: registry() };

    case "status": {
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (!response) throw new Fatal(EXIT.daemonDown, `no daemon on port ${port}. Is the app running?`);

      const health = await response.json();
      const plugins = health.plugins.map((p) => `  ${p.placeName ?? "unnamed"} ${dim(`(${p.placeId})`)}`);

      return {
        json: health,
        text: [
          `daemon   listening on ${health.port}`,
          `plugins  ${health.plugins.length}`,
          ...plugins,
        ].join("\n"),
      };
    }

    case "projects": {
      const { decode, encode } = await import("@msgpack/msgpack");
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "GET",
        headers: { accept: "application/msgpack" },
      }).catch(() => null);

      if (!response) throw new Fatal(EXIT.daemonDown, `no daemon on port ${port}`);

      const projects = decode(new Uint8Array(await response.arrayBuffer()));
      void encode;

      return {
        json: projects,
        text: projects.length
          ? projects.map((p) => `  ${p.running ? "●" : "○"} ${p.name.padEnd(24)} ${dim(p.path)}`).join("\n")
          : dim("(no projects)"),
      };
    }

    case "verse": {
      const { verseOfTheDay } = await import("../quran/daily.js");
      const verse = verseOfTheDay();
      const translation = flags.translation ?? "khattab";

      return {
        json: verse,
        text: [
          verse.verses.map((v) => v.arabic).join(" "),
          "",
          verse.verses.map((v) => v.translations[translation]).join(" "),
          dim(`— ${verse.surah.name} ${verse.ref}`),
        ].join("\n"),
      };
    }

    default:
      throw new UsageError(`no local handler for ${name}`);
  }
}

/**
 * Runs a custom command.
 *
 * `ctx` is the same op surface the CLI uses — a custom command can do exactly
 * what a built-in can, and nothing more.
 */
async function runCustom(command, flags, port) {
  const ctx = {
    op: (op, args = {}) => daemon(port, "/op", { op, args, timeoutMs: 120000 }),
    photo: async ({ region, out }) => {
      const args = {};
      if (region) {
        const [x, y, width, height] = String(region).split(",").map(Number);
        args.region = { x, y, width, height };
      }
      const result = await daemon(port, "/op", { op: "photo", args, timeoutMs: 120000 });
      result.file = await writePhoto(port, result, { out });
      return result;
    },
  };

  const result = await runCommand(command, {
    args: bindArgs(command, flags),
    ctx,
    // Progress goes to stderr so `--raw` piped to jq stays clean JSON.
    log: (message) => process.stderr.write(`${dim(message)}\n`),
  });

  process.stdout.write(`${flags.raw ? JSON.stringify(result ?? null, null, 2) : formatCustom(result)}\n`);
  return EXIT.ok;
}

function formatCustom(result) {
  if (result === null || result === undefined) return dim("(done)");
  if (typeof result !== "object") return String(result);
  return JSON.stringify(result, null, 2);
}

/** Reads a capture artifact, encodes it, and writes the file. */
async function writePhoto(port, result, flags) {
  const { encodePng } = await import("../daemon/png.js");
  const { decode, encode } = await import("@msgpack/msgpack");

  const parts = [];
  let offset = 0;

  // Paged, because a full viewport is tens of megabytes and the daemon caps
  // each read.
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/artifacts/read`, {
      method: "POST",
      body: Buffer.from(encode({ id: result.artifact, offset })),
    });

    const page = decode(new Uint8Array(await response.arrayBuffer()));

    if (page.error) throw new Fatal(EXIT.pluginError, `could not read the capture: ${page.error}`);

    parts.push(Buffer.from(page.dataBase64, "base64"));
    offset = page.nextOffset;

    if (page.eof) break;
  }

  const rgba = Buffer.concat(parts);

  if (rgba.length !== result.byteLength) {
    throw new Fatal(EXIT.pluginError, `capture truncated: expected ${result.byteLength} bytes, got ${rgba.length}`);
  }

  const file = path.resolve(String(flags.out ?? "capture.png"));
  writeFileSync(file, encodePng(rgba, result.width, result.height));

  return file;
}

/** Turns positionals and flags into the op's argument object. */
function opArguments(name, spec, positionals, flags) {
  const { raw, port, help: wantsHelp, ...rest } = flags;
  void raw;
  void port;
  void wantsHelp;

  if (name === "photo" && typeof rest.region === "string") {
    const numbers = rest.region.split(",").map((part) => Number(part.trim()));

    if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) {
      throw new UsageError("--region takes x,y,width,height");
    }

    const [x, y, width, height] = numbers;
    rest.region = { x, y, width, height };
  }

  // `out` names a local file; the plugin has no use for it.
  delete rest.out;

  // --props Name,Text is friendlier than repeating a flag or writing JSON.
  if (name === "query" && typeof rest.props === "string") {
    rest.props = rest.props.split(",").map((part) => part.trim()).filter(Boolean);
  }

  if (spec.variadic) {
    return { ...coerceAll(rest), [spec.variadic]: positionals.length ? positionals : undefined };
  }

  return { ...coerceAll(rest), ...bind(name, positionals, spec.positional) };
}

const coerceAll = (flags) =>
  Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, typeof value === "string" ? coerce(value) : value]));

async function main(argv) {
  const { command, positionals, flags } = parse(argv);
  const port = Number(flags.port ?? process.env.MUSLIMSYNC_PORT ?? DEFAULT_PORT);

  if (!command || command === "help") {
    // `msync help photo` is the form people reach for first, and answering it
    // with the full index makes the tool look like it has no per-command help.
    if (positionals[0] && COMMANDS[positionals[0]]) {
      process.stdout.write(`${commandHelp(positionals[0])}\n`);
      return EXIT.ok;
    }

    const { commands: custom } = discover({ project: process.cwd(), appRoot: APP_ROOT });
    process.stdout.write(`${help(custom)}\n`);
    return EXIT.ok;
  }

  const spec = COMMANDS[command];

  if (!spec) {
    // A name we do not know might be a command the user dropped in a folder.
    const custom = discover({ project: process.cwd(), appRoot: APP_ROOT }).commands.find((c) => c.name === command);

    if (custom) return runCustom(custom, flags, port);

    process.stderr.write(`${red("unknown command")}: ${command}\n\n${help()}\n`);
    return EXIT.usage;
  }

  if (flags.help === true) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return EXIT.ok;
  }

  if (spec.local) {
    const result = await local(spec.local, { flags, port });
    process.stdout.write(`${flags.raw ? JSON.stringify(result.json ?? null, null, 2) : result.text}\n`);
    return EXIT.ok;
  }

  // Latency is a property of the round trip, which only this end can see —
  // the plugin has no idea when the request left.
  const startedAt = Date.now();
  const result = await daemon(port, "/op", {
    op: spec.op,
    args: opArguments(command, spec, positionals, flags),
    // A capture ships megabytes of RGBA through base64 chunks; the default is
    // sized for reads that answer instantly.
    timeoutMs: spec.timeoutMs,
  });

  if (command === "ping") result.latencyMs = Date.now() - startedAt;

  // The plugin hands back raw RGBA in an artifact; turning it into a file is
  // this side's job, because that is where zlib lives.
  if (command === "photo") result.file = await writePhoto(port, result, flags);

  process.stdout.write(`${flags.raw ? JSON.stringify(result, null, 2) : render(command, result)}\n`);
  return EXIT.ok;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${red("usage")}: ${error.message}\n`);
      process.exit(EXIT.usage);
    }

    if (error instanceof Fatal) {
      process.stderr.write(`${red(error.code ?? "error")}: ${error.message}\n`);
      process.exit(error.exit);
    }

    process.stderr.write(`${red("error")}: ${error.message}\n`);
    process.exit(1);
  });

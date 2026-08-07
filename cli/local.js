// Commands answered without touching the plugin.
//
// Split from msync.js so the dispatcher stays a dispatcher: these each have
// their own shape, and none of them is about routing an op.
//
// `daemon`, `Fatal` and `EXIT` are passed in rather than imported to keep the
// dependency pointing one way — msync.js owns the transport and the exit codes.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { registry } from "./commands.js";
import { help, dim } from "./format.js";
import { renderAgentsMd, mergeInto, groupNames } from "./agents.js";
import { runTest, formatVerdict, TestFailure } from "./playtest.js";
import { UsageError } from "./args.js";

/** Commands answered without touching the plugin. */
export async function local(name, { flags, positionals = [], port, daemon, Fatal, EXIT }) {
  switch (name) {
    case "help":
      return { text: help() };

    case "commands":
      return { json: registry() };

    case "agents": {
      // Narrowed to what a project actually does: a place that never captures
      // anything should not spend context explaining capture.
      let options;

      if (typeof flags.only === "string") {
        const known = groupNames();
        const wanted = flags.only.split(",").map((part) => part.trim()).filter(Boolean);
        const resolved = wanted.map((name) => known.find((group) => group.toLowerCase() === name.toLowerCase()));
        const unknown = wanted.filter((_, index) => !resolved[index]);

        if (unknown.length) {
          throw new UsageError(`unknown group(s): ${unknown.join(", ")}. Known: ${known.join(", ")}`);
        }

        options = { groups: resolved };
      } else if (flags.all) {
        options = { groups: "all" };
      }

      const markdown = renderAgentsMd(options);

      // Printed as well as committed: an agent pointed at a machine, rather
      // than at the repo, still has a way to ask what this tool can do.
      if (!flags.install) return { text: markdown, json: { markdown } };

      // A game's repository is where an agent actually works, and it has no
      // reason to know this tool exists. `gh` is recognised because it is in
      // the training data; nothing here is.
      const into = path.resolve(typeof flags.install === "string" ? flags.install : ".");

      // A path that does not exist is almost always a typo in the directory,
      // and a raw ENOENT names the file rather than the thing that is wrong.
      if (!existsSync(into) || !statSync(into).isDirectory()) {
        throw new Fatal(EXIT.usage, `no such directory: ${into}`);
      }

      const target = path.join(into, "AGENTS.md");

      let before = "";
      try {
        before = readFileSync(target, "utf8");
      } catch {
        // A project with no AGENTS.md yet is the common case, not an error.
      }

      const after = mergeInto(before, options);

      if (after === before) return { text: `${target} is already up to date`, json: { path: target, changed: false } };

      writeFileSync(target, after);

      return {
        text: `${before ? "updated" : "wrote"} ${target}`,
        json: { path: target, changed: true, created: !before },
      };
    }

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

    case "test": {
      const file = positionals[0];
      if (!file) throw new UsageError("test needs a file");

      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        throw new Fatal(EXIT.usage, `cannot read ${file}`);
      }

      const op = (name, args = {}) => daemon(port, "/op", { op: name, args, timeoutMs: 120000 });

      try {
        const verdict = await runTest(op, {
          source,
          context: flags.context ?? "server",
          mode: flags.mode ?? "play",
          players: flags.players === undefined ? undefined : Number(flags.players),
          log: (message) => process.stderr.write(`${dim(message)}\n`),
        });

        return { json: verdict, text: formatVerdict(verdict) };
      } catch (cause) {
        if (cause instanceof TestFailure) {
          throw new Fatal(EXIT.testFailed, `FAIL  ${cause.context}\n${cause.message}`);
        }
        throw cause;
      }
    }

    default:
      throw new UsageError(`no local handler for ${name}`);
  }
}


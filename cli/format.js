// Human-readable rendering of op results.
//
// `--raw` prints the JSON verbatim; everything here is for the other case. The
// aim is that a human reading a terminal sees the answer, not a data structure.

import { decodeValue } from "./playtest.js";
import { COMMANDS, GROUPS } from "./commands.js";

const isTTY = process.stdout.isTTY;
const paint = (code, text) => (isTTY ? `[${code}m${text}[0m` : text);

export const dim = (text) => paint(90, text);
export const bold = (text) => paint(1, text);
export const green = (text) => paint(32, text);
export const red = (text) => paint(31, text);
export const cyan = (text) => paint(36, text);

/** Renders a tagged value back to something short and readable. */
export function value(input) {
  if (input === null || input === undefined) return dim("nil");
  if (typeof input !== "object") return String(input);

  switch (input.__type) {
    case "Vector3":
      return `${input.x}, ${input.y}, ${input.z}`;
    case "Vector2":
      return `${input.x}, ${input.y}`;
    case "Color3":
      return `rgb(${[input.r, input.g, input.b].map((c) => Math.round(c * 255)).join(", ")})`;
    case "UDim2":
      return `{${input.x.scale}, ${input.x.offset}}, {${input.y.scale}, ${input.y.offset}}`;
    case "UDim":
      return `${input.scale}, ${input.offset}`;
    case "EnumItem":
      return `Enum.${input.enum}.${input.name}`;
    case "BrickColor":
      return input.name;
    case "NumberRange":
      return `${input.min} .. ${input.max}`;
    case "CFrame":
      return input.components.slice(0, 3).map((n) => round(n)).join(", ") + dim(" (+rotation)");
    case "Instance":
      return `${input.path} ${dim(`(${input.class})`)}`;
    case "Unsupported":
      return dim(`<${input.of}>`);
    default:
      return JSON.stringify(input);
  }
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(3)));

function properties(map) {
  const names = Object.keys(map).sort();
  const width = Math.max(...names.map((n) => n.length), 0);
  return names.map((name) => `  ${dim(name.padEnd(width))}  ${value(map[name])}`).join("\n");
}

function treeLines(node, prefix = "", isLast = true, depth = 0) {
  const branch = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
  const label = `${prefix}${branch}${node.name} ${dim(node.class)}`;
  const lines = [node.truncated ? `${label} ${dim(`(+${node.childCount} more)`)}` : label];

  const children = node.children ?? [];
  const nextPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : "│  ");

  children.forEach((child, index) => {
    lines.push(...treeLines(child, nextPrefix, index === children.length - 1, depth + 1));
  });

  return lines;
}

/** Picks a renderer by command name, falling back to indented JSON. */
export function render(command, result) {
  if (result === null || result === undefined) return dim("(no output)");

  switch (command) {
    case "get":
      if (result.prop) return `${dim(result.prop)}  ${value(result.value)}`;
      return [`${bold(result.path || "game")} ${dim(result.class)}`, properties(result.properties ?? {})].join("\n");

    case "props":
      return [`${bold(result.path)} ${dim(result.class)}`, properties(result.properties ?? {})].join("\n");

    case "ls": {
      const rows = (result.children ?? []).map(
        (child) => `  ${child.name.padEnd(28)} ${dim(child.class)}${child.childCount ? dim(` (${child.childCount})`) : ""}`,
      );
      const header = `${bold(result.path || "game")} ${dim(`— ${result.total} child(ren)`)}`;
      return [header, ...rows, result.truncated ? dim("  … truncated") : null].filter(Boolean).join("\n");
    }

    case "tree":
      return treeLines(result).join("\n");

    case "find": {
      const rows = (result.matches ?? []).map((m) => `  ${m.path} ${dim(m.class)}`);
      // Say what was searched, so a surprising result set is explainable
      // rather than mysterious.
      const scope = Array.isArray(result.under) ? `${result.under.length} services` : result.under;
      const note = dim(
        `${result.matches.length} match(es) in ${scope}, visited ${result.visited}${result.truncated ? ", truncated" : ""}`,
      );
      return [...rows.length ? rows : [dim("  (no matches)")], note].join("\n");
    }

    case "query": {
      const rows = (result.matches ?? []).map((m) => {
        const props = m.properties
          ? "  " + Object.entries(m.properties).map(([k, v]) => `${dim(k)}=${value(v)}`).join(" ")
          : "";
        return `  ${m.path} ${dim(m.class)}${props}`;
      });
      const note = dim(
        `${result.matches.length} match(es), visited ${result.visited}` +
          (result.truncated ? `, truncated (${result.truncationReason})` : ""),
      );
      return [...(rows.length ? rows : [dim("  (no matches)")]), note].join("\n");
    }

    case "source":
      return result.source ?? "";

    case "set":
      return `${bold(result.path)} ${dim(result.prop)}  ${value(result.before)} ${dim("→")} ${green(value(result.after))}`;

    case "new":
      return `${green("created")} ${result.path} ${dim(result.class)}`;

    case "rm":
      return `${red("destroyed")} ${result.path}`;

    case "mv":
      return `${result.from} ${dim("→")} ${green(result.to)}`;

    case "attr":
      if (result.attributes) return properties(result.attributes) || dim("(no attributes)");
      if (result.removed) return `${red("removed")} ${result.name}`;
      return `${dim(result.name)}  ${value(result.value)}`;

    case "tag":
      return result.tags?.length ? result.tags.map((t) => `  ${t}`).join("\n") : dim("(no tags)");

    case "select":
      if (result.paths) return result.paths.length ? result.paths.map((p) => `  ${p}`).join("\n") : dim("(nothing selected)");
      return `${green("selected")} ${result.count}`;

    case "eval":
      return result.output?.length ? result.output.join("\n") : value(result.returned);

    case "logs":
      return (result.lines ?? [])
        .map((line) => `${dim(line.at ?? "")} ${levelColour(line.level)(line.level.padEnd(5))} ${line.message}`)
        .join("\n");

    case "ping":
      return `${green("pong")} ${dim(`${result.latencyMs}ms`)}`;

    case "undo":
      return green("undone");

    case "redo":
      return green("redone");

    case "save":
      return `${green("saving")} ${dim("(Studio saves asynchronously)")}`;

    case "copy":
      return [
        `${green("copied")} ${result.roots.length} root(s), ${bytes(result.size)}`,
        ...result.roots.map((r) => `  ${r.path} ${dim(r.class)}`),
      ].join("\n");

    case "paste":
      return [
        `${green("pasted")} ${result.count} root(s) into ${result.to}`,
        ...result.roots.map((r) => `  ${r.path} ${dim(r.class)}`),
      ].join("\n");

    case "photo":
      return [
        `${green("captured")} ${result.width}x${result.height} ${dim(`(viewport ${result.viewport.width}x${result.viewport.height})`)}`,
        `${dim("written to")} ${result.file}`,
      ].join("\n");

    case "authorize":
      return `${green("authorized")} ${dim("screen capture is available")}`;

    case "playtest":
      return `${green("playtest started")} ${dim(`${result.mode}${result.players > 1 ? `, ${result.players} players` : ""}`)}`;

    case "playing": {
      if (!result.running) return dim("no playtest running");
      const rows = result.contexts.map((c) => `  ${c.name} ${dim(c.kind)}`);
      return [`${green("running")} ${dim(`${result.contexts.length} context(s)`)}`, ...rows].join("\n");
    }

    case "stop":
      return `${green("stopped")}`;

    case "run": {
      if (result.ok === false) return `${red("error")} ${result.error}`;

      // Decoded the same way `msync test` decodes it: the same script through
      // two commands should not print two different shapes.
      const value = decodeValue(result);

      if (value === null) return `${dim(result.context)}  ${dim("nil")}`;

      return `${dim(result.context)}  ${typeof value === "object" ? JSON.stringify(value, null, 2) : value}`;
    }

    case "capabilities":
      return [
        `plugin ${bold(result.pluginVersion)}  protocol ${result.protocolVersion}`,
        `place  ${result.place.name} ${dim(`(${result.place.placeId})`)}`,
        "features:",
        ...Object.entries(result.features).map(([k, v]) => `  ${v ? green("✓") : red("✗")} ${k}`),
        `ops: ${dim(result.ops.join(", "))}`,
      ].join("\n");

    default:
      return JSON.stringify(result, null, 2);
  }
}

const levelColour = (level) => (level === "error" ? red : level === "warn" ? cyan : dim);

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The help screen, derived from the command table. */
export function help(custom = []) {
  const lines = [bold("msync") + dim(" — Roblox Studio from the command line"), ""];

  for (const group of GROUPS) {
    const entries = Object.entries(COMMANDS).filter(([, spec]) => spec.group === group);
    if (!entries.length) continue;

    lines.push(bold(group));
    const width = Math.max(...entries.map(([name]) => name.length));

    for (const [name, spec] of entries) {
      lines.push(`  ${cyan(name.padEnd(width))}  ${spec.summary}`);
    }
    lines.push("");
  }

  if (custom.length) {
    lines.push(bold("Custom"));
    const width = Math.max(...custom.map((c) => c.name.length));
    for (const command of custom) lines.push(`  ${cyan(command.name.padEnd(width))}  ${command.description}`);
    lines.push("");
  }

  lines.push(dim("--raw for JSON · --port to target another daemon · msync <command> --help"));
  return lines.join("\n");
}

/**
 * Every command in one group, in full.
 *
 * The agent brief indexes the groups it left out and points here, so this is
 * the other half of that promise: naming a group has to produce the commands.
 */
export function groupHelp(name) {
  const wanted = GROUPS.find((group) => group.toLowerCase() === name.toLowerCase());
  if (!wanted) return null;

  const entries = Object.entries(COMMANDS).filter(([, spec]) => spec.group === wanted);
  if (!entries.length) return null;

  const width = Math.max(...entries.map(([command]) => command.length));

  return [
    bold(wanted),
    "",
    ...entries.map(([command, spec]) => `  ${command.padEnd(width)}  ${spec.summary}`),
    "",
    dim(`msync help <command> for flags and examples`),
  ].join("\n");
}

/** Per-command help, also derived. */
export function commandHelp(name) {
  const spec = COMMANDS[name];
  if (!spec) return `no such command: ${name}`;

  const lines = [`${bold(name)} — ${spec.summary}`];

  if (spec.positional) {
    const required = (spec.positional.required ?? []).map((a) => `<${a}>`);
    const optional = (spec.positional.optional ?? []).map((a) => `[${a}]`);
    lines.push("", `  msync ${name} ${[...required, ...optional].join(" ")}`.trimEnd());
  } else if (spec.variadic) {
    lines.push("", `  msync ${name} [${spec.variadic}...]`);
  }

  if (spec.flags) {
    lines.push("", bold("Flags"));
    const width = Math.max(...Object.keys(spec.flags).map((f) => f.length));
    for (const [flag, description] of Object.entries(spec.flags)) {
      lines.push(`  --${flag.padEnd(width)}  ${description}`);
    }
  }

  if (spec.examples?.length) {
    lines.push("", bold("Examples"), ...spec.examples.map((e) => `  ${dim(e)}`));
  }

  return lines.join("\n");
}

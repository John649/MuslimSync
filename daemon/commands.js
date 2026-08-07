// Custom commands.
//
// A command is a folder with a command.json and a handler. Dropping one in
// gives you the CLI command, an entry in the agent registry, and a button in
// the app — all from the same declaration, with nothing to register.
//
// This is where MuslimSync deliberately differs from Ro Sync, whose command
// registry is 62 JSON files that only produce documentation for commands
// defined separately in Rust. Here the registry is the implementation.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Where commands are looked for, nearest first. A project overrides a global. */
export function searchRoots({ project, appRoot } = {}) {
  const roots = [];

  if (project) roots.push(path.join(project, ".muslimsync", "commands"));
  roots.push(path.join(homedir(), ".muslimsync", "commands"));
  if (appRoot) roots.push(path.join(appRoot, "commands"));

  return roots;
}

export class CommandError extends Error {}

export const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validates one command.json.
 *
 * Strict about the name because it becomes a CLI verb: anything that needs
 * quoting, or collides with a flag, is a command nobody can invoke.
 */
export function validate(manifest, folder) {
  if (!manifest || typeof manifest !== "object") throw new CommandError(`${folder}: command.json must be an object`);

  const { name, description } = manifest;

  if (typeof name !== "string" || !NAME.test(name)) {
    throw new CommandError(`${folder}: name must be lower-case letters, digits and dashes (got ${JSON.stringify(name)})`);
  }

  if (path.basename(folder) !== name) {
    // Otherwise `msync foo` runs the thing in the `bar` folder, and nobody can
    // find it again.
    throw new CommandError(`${folder}: name "${name}" must match its folder name`);
  }

  if (typeof description !== "string" || !description.trim()) {
    throw new CommandError(`${folder}: description is required`);
  }

  const args = manifest.args ?? {};

  if (typeof args !== "object" || Array.isArray(args)) throw new CommandError(`${folder}: args must be an object`);

  for (const [flag, spec] of Object.entries(args)) {
    if (!spec || typeof spec !== "object") throw new CommandError(`${folder}: arg "${flag}" must be an object`);
    if (spec.required && "default" in spec) {
      // A required arg with a default is a contradiction, and silently picking
      // one meaning would surprise whoever wrote it.
      throw new CommandError(`${folder}: arg "${flag}" is required but also has a default`);
    }
  }

  return {
    name,
    description: description.trim(),
    category: typeof manifest.category === "string" ? manifest.category : "Custom",
    args,
    examples: Array.isArray(manifest.examples) ? manifest.examples : [],
  };
}

const HANDLERS = [
  { file: "run.js", kind: "node" },
  { file: "run.luau", kind: "luau" },
  { file: "workflow.json", kind: "workflow" },
];

/** Reads one command folder, or throws explaining why it cannot be used. */
export function load(folder) {
  const manifestPath = path.join(folder, "command.json");

  if (!existsSync(manifestPath)) throw new CommandError(`${folder}: no command.json`);

  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new CommandError(`${folder}: command.json is not valid JSON (${cause.message})`);
  }

  const manifest = validate(raw, folder);
  const handler = HANDLERS.find((candidate) => existsSync(path.join(folder, candidate.file)));

  if (!handler) {
    throw new CommandError(`${folder}: needs one of ${HANDLERS.map((h) => h.file).join(", ")}`);
  }

  return { ...manifest, folder, kind: handler.kind, handler: path.join(folder, handler.file) };
}

/**
 * Every usable command across the search roots.
 *
 * A broken folder does not stop the others from loading — one bad command.json
 * should not take the whole command surface down — but it is reported so it can
 * be fixed rather than silently vanishing.
 */
export function discover(options = {}) {
  const commands = new Map();
  const problems = [];

  for (const root of searchRoots(options)) {
    let entries;

    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const folder = path.join(root, entry.name);

      try {
        const command = load(folder);
        // Nearest root wins, so a project can override a global command.
        if (!commands.has(command.name)) commands.set(command.name, command);
      } catch (cause) {
        problems.push(cause.message);
      }
    }
  }

  return { commands: [...commands.values()], problems };
}

/** Binds CLI flags to a command's declared args, applying defaults. */
export function bindArgs(command, flags) {
  const bound = {};

  for (const [name, spec] of Object.entries(command.args)) {
    const supplied = flags[name];

    if (supplied === undefined) {
      if (spec.required) throw new CommandError(`${command.name} needs --${name}`);
      if ("default" in spec) bound[name] = spec.default;
      continue;
    }

    bound[name] = coerceArg(supplied, spec, name);
  }

  return bound;
}

function coerceArg(value, spec, name) {
  switch (spec.type) {
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new CommandError(`--${name} must be a number`);
      return number;
    }
    case "boolean":
      return value === true || value === "true";
    default:
      return String(value);
  }
}

/** Runs a command, whatever kind it is. */
export async function run(command, { args, ctx, log = () => {} }) {
  if (command.kind === "node") {
    const module = await import(pathToFileURL(command.handler).href);
    const entry = module.default;

    if (typeof entry !== "function") {
      throw new CommandError(`${command.name}: run.js must default-export a function`);
    }

    return entry({ args, ctx, log });
  }

  if (command.kind === "luau") {
    // The source runs in Studio through the ordinary eval op, so a Luau
    // command has exactly the reach an eval does — no more.
    const source = readFileSync(command.handler, "utf8");
    return ctx.op("eval", { source: withArgs(source, args) });
  }

  if (command.kind === "workflow") {
    const definition = JSON.parse(readFileSync(command.handler, "utf8"));
    return runWorkflow(definition, { ctx, args, log });
  }

  throw new CommandError(`${command.name}: unknown handler kind ${command.kind}`);
}

/** Prepends the command's args as a Luau table, so a script can read them. */
function withArgs(source, args) {
  return `local args = game:GetService("HttpService"):JSONDecode([[${JSON.stringify(args)}]])\n${source}`;
}

export function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- workflows

/**
 * Runs a declarative workflow: a list of steps, each an op, with later steps
 * able to reference earlier results.
 *
 * References look like `$stepId.value.properties.Name` and preserve the JSON
 * type they point at, so a Vector3 stays an object rather than being stringified
 * into the next call. A leading `$$` escapes a literal dollar.
 *
 * Deliberately not a language: no loops, no conditionals, no expressions. A
 * workflow that needs those should be a run.js, where the reader gets a real
 * one instead of a half-invented one.
 */
export async function runWorkflow(definition, { ctx, args = {}, log = () => {} }) {
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new CommandError("a workflow needs a steps array");
  }

  const results = { args };

  for (const [index, step] of definition.steps.entries()) {
    const where = step.id ?? `step ${index + 1}`;

    if (typeof step.op !== "string" || !step.op) {
      throw new CommandError(`${where}: op is required`);
    }

    const resolved = resolveRefs(step.args ?? {}, results, where);

    log(`${where}: ${step.op}`);

    const value = await ctx.op(step.op, resolved);

    if (step.id) {
      if (results[step.id]) throw new CommandError(`${where}: duplicate step id "${step.id}"`);
      results[step.id] = { value };
    }

    if (step.assert) assertStep(step.assert, value, where);
  }

  return results;
}

/** Replaces $ref strings anywhere in an args tree. */
function resolveRefs(node, results, where) {
  if (typeof node === "string") return resolveRef(node, results, where);
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, results, where));

  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveRefs(value, results, where)]));
  }

  return node;
}

function resolveRef(text, results, where) {
  if (text.startsWith("$$")) return text.slice(1);
  if (!text.startsWith("$")) return text;

  const [head, ...rest] = text.slice(1).split(".");

  if (!(head in results)) {
    // Naming the available ids turns a typo into a one-look fix.
    throw new CommandError(`${where}: "$${head}" is not a known step (have: ${Object.keys(results).join(", ")})`);
  }

  let value = results[head];

  for (const key of rest) {
    if (value === null || value === undefined) {
      throw new CommandError(`${where}: ${text} walked off the end at "${key}"`);
    }
    value = value[key];
  }

  return value;
}

function assertStep(expectation, value, where) {
  for (const [path, expected] of Object.entries(expectation)) {
    let actual = value;
    for (const key of path.split(".")) actual = actual?.[key];

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // A workflow that quietly continued past a failed expectation would
      // report success for a run that did the wrong thing.
      throw new CommandError(`${where}: expected ${path} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
}

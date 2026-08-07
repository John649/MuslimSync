// `msync new-command` — scaffolds a custom command folder.
//
// The point is that the generated folder works before it is edited: every
// template passes daemon/commands.js's load() and does something harmless when
// run, so the first edit starts from a working example rather than a stub that
// errors until it is finished.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { NAME } from "../daemon/commands.js";
import { COMMANDS } from "./commands.js";
import { UsageError } from "./args.js";

/** Where a scope puts its commands. Mirrors daemon/commands.js's searchRoots. */
export function rootFor(scope, { cwd = process.cwd(), home = homedir() } = {}) {
  return scope === "global"
    ? path.join(home, ".muslimsync", "commands")
    : path.join(cwd, ".muslimsync", "commands");
}

const manifest = (name) =>
  `${JSON.stringify(
    {
      name,
      description: `Describe what ${name} does`,
      category: "Custom",
      args: {
        path: { type: "string", default: "Workspace", help: "instance to operate on" },
      },
      examples: [`msync ${name}`, `msync ${name} --path Workspace/Level1`],
    },
    null,
    2,
  )}\n`;

const luauTemplate = () => `-- \`args\` is in scope, decoded from command.json's declared arguments.
-- This source runs in Studio through the ordinary eval op, so it has exactly
-- the reach an eval does and no more.

local root = game

for segment in tostring(args.path):gmatch("[^/]+") do
	root = root:FindFirstChild(segment) or error(\`no instance at {args.path}\`)
end

return { path = args.path, children = #root:GetChildren() }
`;

const nodeTemplate = () => `// A custom command in Node. \`ctx.op\` is the same surface the CLI uses — a
// custom command can do exactly what a built-in can, and nothing more.

export default async function ({ args, ctx, log }) {
  log(\`reading \${args.path}\`);

  const listing = await ctx.op("ls", { path: args.path });

  return { path: args.path, children: listing.children.map((child) => child.name) };
}
`;

const workflowTemplate = () => `${JSON.stringify(
  {
    description: "Declarative steps. $args.* reads the command's arguments; $<id>.value.* reads an earlier step's result.",
    steps: [{ id: "read", op: "get", args: { path: "$args.path" } }],
  },
  null,
  2,
)}\n`;

const KINDS = {
  luau: { file: "run.luau", template: luauTemplate, runs: "runs in Studio" },
  node: { file: "run.js", template: nodeTemplate, runs: "runs on this machine" },
  workflow: { file: "workflow.json", template: workflowTemplate, runs: "declarative steps, no code" },
};

export const KIND_NAMES = Object.keys(KINDS);

/**
 * A self-contained brief for an AI assistant that is about to write a command.
 *
 * Built from the same templates the scaffolder writes, so what the assistant is
 * told and what `msync new-command` produces cannot drift apart. Self-contained
 * on purpose: it is meant to be pasted into a chat that has never seen this
 * repository.
 */
export function authoringBrief() {
  return `# Writing a MuslimSync custom command

You are writing a custom command for MuslimSync, a tool that drives a running
Roblox Studio from the command line (\`msync\`). One folder becomes a CLI verb,
a button in the MuslimSync app, and an agent-registry entry at once. There is
no registration step and no build: the folder is discovered on every run.

## Where the folder goes

- \`<project>/.muslimsync/commands/<name>/\` — available in that project only
- \`~/.muslimsync/commands/<name>/\` — available from every project

A project command overrides a global one with the same name. The shortcut
\`msync new-command <name> [--kind luau|node|workflow] [--global]\` scaffolds a
working folder; editing that beats starting blank.

## The folder

Exactly two files: \`command.json\`, plus one of \`run.luau\`, \`run.js\`, or
\`workflow.json\`.

### command.json

\`\`\`json
${manifest("glow-parts").trimEnd()}
\`\`\`

Rules the loader enforces:

- \`name\` must equal the folder name, and match \`${NAME.source}\`
- \`description\` is required and must be non-empty
- an arg may be \`"required": true\` or have a \`"default"\`, never both
- an arg's \`type\` is \`string\` (the default), \`number\`, or \`boolean\`
- the name must not shadow a built-in verb — \`msync commands --raw\` lists
  what is taken

## Pick one handler kind

### run.luau — runs inside Studio

The source runs through the ordinary eval op, so it has exactly the reach an
eval does. \`args\` is already in scope, decoded from command.json. Whatever it
returns becomes the command's output.

\`\`\`luau
${luauTemplate().trimEnd()}
\`\`\`

### run.js — runs on the user's machine, in Node

Default-export an async function. \`ctx.op(name, args)\` calls any op the CLI
can (\`ls\`, \`get\`, \`set\`, \`eval\`, …); \`ctx.photo({ region, out })\`
captures the viewport to a file; \`log(text)\` reports progress.

\`\`\`js
${nodeTemplate().trimEnd()}
\`\`\`

### workflow.json — declarative steps, no code

Each step names an op. \`$args.x\` reads a command argument; \`$<stepId>.value.<path>\`
reads an earlier step's result, preserving JSON types; \`$$\` escapes a literal
dollar. An \`assert\` object fails the run when a result path is not the value
expected. Deliberately no loops or conditionals — a workflow that needs those
should be a run.js instead.

\`\`\`json
${workflowTemplate().trimEnd()}
\`\`\`

## Check it works

- \`msync <name>\` runs it immediately — no build, no restart
- \`msync help <name>\` shows its args; \`msync help\` lists it under its category
- a folder that fails to load is reported in \`msync commands --raw\` under
  \`problems\`, with the reason
- \`msync agents\` prints the full tool brief (paths, selectors, exit codes) if
  you need more than this page
`;
}

/**
 * Creates the folder and its two files, or throws explaining why not.
 *
 * Refuses rather than overwrites: the folder may hold a command someone spent
 * time on, and "scaffold" must never be the command that deletes work.
 */
export function scaffold({ name, kind = "luau", scope = "project", cwd, home }) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new UsageError(
      `a command name is lower-case letters, digits and dashes (got ${JSON.stringify(name ?? "")})`,
    );
  }

  if (COMMANDS[name]) {
    // Built-ins dispatch first, so a custom command with this name could never
    // be invoked — better to say so now than after it is written.
    throw new UsageError(`"${name}" is a built-in msync command; pick another name`);
  }

  const chosen = KINDS[kind];
  if (!chosen) throw new UsageError(`--kind takes ${KIND_NAMES.join(", ")} (got ${kind})`);

  const folder = path.join(rootFor(scope, { cwd, home }), name);

  if (existsSync(folder)) throw new UsageError(`${folder} already exists — edit it, or pick another name`);

  mkdirSync(folder, { recursive: true });

  const files = {
    "command.json": manifest(name),
    [chosen.file]: chosen.template(),
  };

  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(folder, file), content);
  }

  return { folder, files: Object.keys(files), kind, runs: chosen.runs, scope };
}

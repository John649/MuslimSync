// The agent-facing brief.
//
// AGENTS.md is the convention coding agents actually read — an open format
// agreed in August 2025 and understood by most of the tools now. It is plain
// markdown with no required schema, so the only real design questions are what
// to say and how much.
//
// The command table is generated from the same registry the CLI dispatches on,
// because a hand-written list of commands is wrong the first time a command
// changes and nobody notices until an agent calls something that no longer
// exists. The prose around it is hand-written: it is the part a registry cannot
// know, and it is what stops an agent making the mistakes this tool invites.
//
// Kept short on purpose. This gets injected into a context window, so every
// line has to earn the tokens — flags and examples stay in `msync help <cmd>`,
// which an agent can call when it actually needs them.

import { COMMANDS, GROUPS } from "./commands.js";

// What almost every task needs. The rest is indexed instead of listed, because
// a brief that spells out screen capture for an agent renaming a part has spent
// the tokens either way.
const CORE = ["Navigate", "Write", "Studio", "Transfer"];

const PREAMBLE = `# MuslimSync

Drives a running Roblox Studio from the command line: read and write the live
DataModel, capture the viewport, and run Luau inside a real playtest.

Requires the MuslimSync app running and a Studio place open with the plugin
connected. \`msync status\` says whether both are true; \`msync doctor\` says what
to do when they are not. Check one of them first if anything else fails.

The daemon answers on a unix socket as well as on port 7900, and the CLI
prefers the socket — so this works from shells that sandbox loopback
networking, where connecting to 127.0.0.1 fails with EPERM whatever the port.
`;

const CONVENTIONS = `## Conventions worth knowing

- **Paths** are \`/\`-separated from the DataModel root: \`Workspace/Baseplate\`.
  An empty path is the DataModel itself.
- **Selectors** in \`query\` take \`**\` for any depth, and match a Name *or* a
  ClassName: \`msync query 'StarterGui/**/TextButton'\`.
- **Typed properties take the string you would type.** \`Position 0,6,0\`,
  \`Color 255,0,0\`, \`Color '#3b82f6'\`, \`Size 4,1,2\`, \`Material Neon\`. The plugin
  reads the type already in the property and converts. Do not hand-build
  \`{"__type":"Vector3"}\` for the CLI.
- **\`set Parent\` is refused** — use \`mv\`, which does the same thing with the
  checks that make it safe.
- **Every write is one undo step.** A failed write is rolled back rather than
  half-applied.
- **Reads are free and cheap.** Prefer \`ls\`/\`tree\`/\`query\` over \`eval\` for
  anything you could look up; \`eval\` runs arbitrary code in the user's open
  place.

## Exit codes

Branch on these rather than parsing prose.

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | fine | — |
| 2 | bad usage | fix the command; \`msync help <cmd>\` |
| 3 | no plugin connected | ask the user to open a place in Studio |
| 4 | the plugin refused | read the message; it names the cause |
| 5 | cannot reach the daemon | read the message — "is the app running?" and "a sandbox is blocking loopback" are different failures |
| 6 | a test failed | the place is wrong, not the tool |
| 7 | the setup is broken | run \`msync doctor\`; it says what to fix |

## Adding a command

A folder with a \`command.json\` and one of \`run.js\`, \`run.luau\`, or
\`workflow.json\` becomes a CLI verb, an app button, and a registry entry at
once. \`msync new-command <name>\` scaffolds a working one into this project's
\`.muslimsync/commands/\` (or \`~/.muslimsync/commands/\` with \`--global\`, for
every project); \`--kind\` picks \`luau\`, \`node\`, or \`workflow\`. See
\`commands/\` for one of each kind.
`;

const TRANSFER = `## Taking something from another game

The clipboard lives in the daemon, not in Studio, so it survives switching
places. That is what makes "add the quest system from my other game" a real
workflow rather than a rebuild:

1. Open the source place in Studio. \`msync copy ServerScriptService/QuestSystem\`
   — several paths at once also work, and \`msync copy\` with no path takes
   whatever is selected in Studio.
2. Open the destination place. Nothing needs re-copying; the clipboard is still
   holding it.
3. \`msync paste ServerScriptService\`.

It is a real .rbxm round-trip through SerializationService, so what lands is the
exact instances — scripts with their source, properties, and everything nested
inside them — not something rebuilt from a description. Copying a parent and one
of its children inserts that child once, not twice.

The clipboard is in memory: restarting the app empties it. Copy, switch, paste.

**Reach for this before rebuilding anything by hand.** If the user wants a
system that already exists in another place of theirs, copying it is both exact
and faster than recreating it with \`new\` and \`set\`.
`;

const PLAYTESTS = `## Playtests

\`msync test <file.luau>\` starts a playtest, runs the file inside it, stops the
playtest whatever happens, and exits 0 or 6.

The verdict convention is Lua's own: **a script that returns without throwing
passes, \`assert\` fails.** A returned table comes back as JSON. Use
\`--context client\` for client-side checks and \`--mode multiplayer --players N\`
for replication.
`;

const CLOSING = `## Getting more detail

This file is deliberately short. For a command's flags and examples:

\`\`\`bash
msync help <command>      # human-readable
msync commands --raw      # the whole registry as JSON
\`\`\`

## Do not

- Do not run \`eval\` or \`test\` against a place the user has not told you to
  touch. Both execute code in whatever Studio has open right now.
- Do not fabricate a place's state. If a read fails, say so — the DataModel is
  live and the user can see it too.
`;

/** Commands bucketed by group, in the order the CLI presents them. */
function grouped() {
  const byGroup = new Map(GROUPS.map((group) => [group, []]));

  for (const [name, spec] of Object.entries(COMMANDS)) {
    // A command in no known group would silently vanish from the brief, which
    // is exactly the drift generating this file is meant to prevent.
    if (!byGroup.has(spec.group)) byGroup.set(spec.group, []);
    byGroup.get(spec.group).push({ name, spec });
  }

  return byGroup;
}

// How to work *on* MuslimSync, as opposed to how to use it. Deliberately never
// part of renderSection(): a game's repository wants the tool brief, not this
// project's build rules.
//
// Everything here was learned by getting it wrong first.
const REPO = `## Working on this repo

\`\`\`bash
npm run check                     # tests, plugin lint, file-size gate, this file's drift gate
npm run build:plugin -- --install # build the plugin into Studio's plugins folder
npm run gen:agents                # regenerate the tool section below
npm link                          # puts \`msync\` on PATH; without it, node cli/msync.js
aftman install                    # stylua and selene at the versions aftman.toml pins
\`\`\`

**Run \`npm run check\` before committing, not after.** It has caught a red gate
twice in this project's history, both times after the commit had already landed.

- **No Rust is written.** Argon is vendored as a prebuilt binary in
  \`vendor/argon/\`. The sync engine is not ours to modify.
- **Files are capped at 400 lines**, enforced by \`scripts/check-file-size.mjs\`
  with an explicit grandfather list. Split by responsibility, not by line count.
- **Studio does not hot-reload plugins.** After \`build:plugin --install\` you
  must restart Studio, or you are testing the previous build. This has produced
  more than one phantom bug report.
- **Verify Roblox APIs before using them.** Several plausible-sounding ones do
  not exist — \`HttpService:Base64Encode\`, \`ChangeHistoryService:CanUndo\`,
  \`PluginConnectionService:Connect\`, \`PluginConnection.MessageReceived\`. Grep
  a working plugin for the real name; it settles in one look and guessing has
  cost hours.
- **Wire identifiers keep Argon's name on purpose**: \`x-argon-token\`,
  \`argonId\`, \`~/.argon/\`, \`rbxasset://argon/\`, \`ArgonEmpty\`. Renaming them
  breaks compatibility with the vendored binary. The product name is
  \`plugin/src/Version.luau\`.
- **\`plugin/wally.toml\`'s version is load-bearing.** The server refuses to sync
  on a major.minor mismatch.
- **AGENTS.md is generated.** Edit \`cli/agents.js\`, then \`npm run gen:agents\`.
  \`npm run check\` fails if the committed copy is stale.
- macOS arm64 is the only platform vendored or tested.
`;

/** One markdown row per command, so the table cannot drift from the CLI. */
function commandRows(byGroup, groups) {
  const sections = [];

  for (const group of groups) {
    const entries = byGroup.get(group) ?? [];
    if (!entries.length) continue;

    const lines = entries.map(({ name, spec }) => `| \`${usage(name, spec)}\` | ${spec.summary} |`);

    sections.push([`### ${group}`, "", "| Command | Does |", "| --- | --- |", ...lines].join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * A line per group that was left out, naming how to expand it.
 *
 * Listing the verbs is the whole point: an agent has to know that capturing is
 * possible to go looking for it, but does not need the flags until it does.
 */
function index(byGroup, omitted) {
  const rows = [];

  for (const group of omitted) {
    const entries = byGroup.get(group) ?? [];
    if (!entries.length) continue;

    const verbs = entries.map(({ name }) => `\`${name}\``).join(", ");
    rows.push(`| ${group} | ${verbs} |`);
  }

  if (!rows.length) return "";

  return [
    "### Also available",
    "",
    "Not spelled out here. `msync help <group>` lists any of these in full.",
    "",
    "| Group | Commands |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}

/** The shortest true usage line for a command. */
function usage(name, spec) {
  if (spec.positional) {
    const required = (spec.positional.required ?? []).map((a) => `<${a}>`);
    const optional = (spec.positional.optional ?? []).map((a) => `[${a}]`);
    return [name, ...required, ...optional].join(" ");
  }

  if (spec.variadic) return `${name} [${spec.variadic}...]`;

  return name;
}

/**
 * The brief. Deterministic, so a drift check can compare it to disk.
 *
 * `groups` narrows it to what a project actually does — a place that never
 * captures anything should not spend context explaining capture. Passing "all"
 * spells out everything.
 */
export function renderAgentsMd({ groups, repo = false } = {}) {
  const byGroup = grouped();
  const known = [...byGroup.keys()];

  const shown = groups === "all" ? known : (groups ?? CORE).filter((group) => known.includes(group));
  const omitted = known.filter((group) => !shown.includes(group));

  // null means "this part does not apply"; an empty string is a deliberate
  // blank line. Filtering both — which an earlier version did — collapsed
  // every heading onto the line under it.
  return [
    PREAMBLE,
    repo ? REPO : null,
    "## Commands",
    "",
    commandRows(byGroup, shown),
    "",
    omitted.length ? index(byGroup, omitted) : null,
    omitted.length ? "" : null,
    CONVENTIONS,
    // Only when the commands are in scope, same rule as the playtest prose.
    shown.includes("Transfer") ? TRANSFER : null,
    // Only when playtests are in scope. Explaining the verdict convention to an
    // agent that cannot run one is the clearest case of paying for context
    // that will never be used.
    shown.includes("Playtest") ? PLAYTESTS : null,
    CLOSING,
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/** Group names, for the CLI to validate `--only` against. */
export function groupNames() {
  return [...grouped().keys()];
}

// Sentinels so an install can be repeated, and updated, without eating whatever
// else the file says. Everything between them is ours; everything outside is
// the project's and is never touched.
const BEGIN = "<!-- begin muslimsync -->";
const END = "<!-- end muslimsync -->";

/**
 * The brief as a section to drop into a project's own AGENTS.md.
 *
 * A game's repository is where an agent actually works, and it has no reason to
 * know this tool exists — `gh` gets recognised because it is in the training
 * data, and nothing here is. So the brief has to travel to the project rather
 * than wait in this one.
 */
export function renderSection(options) {
  // Every heading drops one level, deepest first so a level is never demoted
  // twice: this is a section inside the project's file, not the whole file.
  const body = renderAgentsMd(options)
    .replace(/^# MuslimSync\n/, "")
    .replace(/^### /gm, "#### ")
    .replace(/^## /gm, "### ");

  return [BEGIN, "", "## MuslimSync", body.trimEnd(), "", END, ""].join("\n");
}

/**
 * The project's AGENTS.md with our section added or refreshed.
 *
 * Idempotent: installing twice leaves one section, and re-installing after an
 * upgrade replaces the old one in place rather than stacking a second copy.
 */
export function mergeInto(existing, options) {
  const section = renderSection(options);

  if (!existing || !existing.trim()) return section;

  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);

  if (start !== -1 && stop !== -1 && stop > start) {
    return existing.slice(0, start) + section.trimEnd() + existing.slice(stop + END.length);
  }

  // Appended rather than prepended: whatever the project already told its
  // agents matters more than what this tool has to say.
  return `${existing.trimEnd()}\n\n${section}`;
}

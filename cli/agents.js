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

const PREAMBLE = `# MuslimSync

Drives a running Roblox Studio from the command line: read and write the live
DataModel, capture the viewport, and run Luau inside a real playtest.

Requires the MuslimSync app running (it hosts the daemon on port 7900) and a
Studio place open with the plugin connected. \`msync status\` says whether both
are true; check it first if anything else fails.
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
| 5 | no daemon | ask the user to start the MuslimSync app |
| 6 | a test failed | the place is wrong, not the tool |

## Playtests

\`msync test <file.luau>\` starts a playtest, runs the file inside it, stops the
playtest whatever happens, and exits 0 or 6.

The verdict convention is Lua's own: **a script that returns without throwing
passes, \`assert\` fails.** A returned table comes back as JSON. Use
\`--context client\` for client-side checks and \`--mode multiplayer --players N\`
for replication.

## Adding a command

A folder with a \`command.json\` and one of \`run.js\`, \`run.luau\`, or
\`workflow.json\` becomes a CLI verb, an app button, and a registry entry at
once. Put it in \`<project>/.muslimsync/commands/\` to scope it to one project.
See \`commands/\` for one of each kind.
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

/** One markdown row per command, so the table cannot drift from the CLI. */
function commandRows() {
  const byGroup = new Map(GROUPS.map((group) => [group, []]));

  for (const [name, spec] of Object.entries(COMMANDS)) {
    // A command in no known group would silently vanish from the brief, which
    // is exactly the drift generating this file is meant to prevent.
    if (!byGroup.has(spec.group)) byGroup.set(spec.group, []);
    byGroup.get(spec.group).push({ name, spec });
  }

  const sections = [];

  for (const [group, entries] of byGroup) {
    if (!entries.length) continue;

    const lines = entries.map(({ name, spec }) => {
      const args = usage(name, spec);
      return `| \`${args}\` | ${spec.summary} |`;
    });

    sections.push([`### ${group}`, "", "| Command | Does |", "| --- | --- |", ...lines].join("\n"));
  }

  return sections.join("\n\n");
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

/** The whole brief. Deterministic, so a drift check can compare it to disk. */
export function renderAgentsMd() {
  return [PREAMBLE, "## Commands", "", commandRows(), "", CONVENTIONS, CLOSING].join("\n");
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
export function renderSection() {
  // Every heading drops one level, deepest first so a level is never demoted
  // twice: this is a section inside the project's file, not the whole file.
  const body = renderAgentsMd()
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
export function mergeInto(existing) {
  const section = renderSection();

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

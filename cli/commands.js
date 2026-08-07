// The command table.
//
// One entry per command, and it is the single source of truth: dispatch, help,
// and the agent-facing registry are all derived from this. There is no second
// list to keep in sync — the thing Ro Sync's docs-only registry got wrong.
//
// `positional` binds bare arguments to op args; anything else arrives as a flag.

export const COMMANDS = {
  // ---------------------------------------------------------- navigation
  get: {
    op: "get",
    group: "Navigate",
    summary: "Read an instance, or one property of it",
    positional: { required: ["path"], optional: ["prop"] },
    examples: ["msync get Workspace/Camera", "msync get Workspace/Camera FieldOfView"],
  },
  ls: {
    op: "ls",
    group: "Navigate",
    summary: "List the children of an instance",
    positional: { optional: ["path"] },
    examples: ["msync ls", "msync ls ReplicatedStorage"],
  },
  tree: {
    op: "tree",
    group: "Navigate",
    summary: "Print a subtree",
    positional: { optional: ["path"] },
    flags: { depth: "how deep to descend (default 3)" },
    examples: ["msync tree Workspace --depth 2"],
  },
  props: {
    op: "props",
    group: "Navigate",
    summary: "Print an instance's readable properties",
    positional: { required: ["path"] },
    examples: ["msync props Workspace/Baseplate"],
  },
  source: {
    op: "source",
    group: "Navigate",
    summary: "Print a script's source, including unsaved editor drafts",
    positional: { required: ["path"] },
    examples: ["msync source ReplicatedStorage/Config"],
  },
  find: {
    op: "find",
    group: "Navigate",
    summary: "Find descendants by class and/or name",
    flags: { class: "class name", name: "name substring", under: "restrict to a subtree" },
    examples: ["msync find --class ProximityPrompt", "msync find --name Boss --under Workspace"],
  },

  // ------------------------------------------------------------- mutation
  set: {
    op: "set",
    group: "Write",
    summary: "Set one property",
    positional: { required: ["path", "prop", "value"] },
    flags: { forceParent: "override the Parent guardrail" },
    examples: ["msync set Workspace/Camera FieldOfView 80"],
  },
  new: {
    op: "new",
    group: "Write",
    summary: "Create an instance",
    positional: { required: ["class"], optional: ["parent", "name"] },
    examples: ["msync new Part Workspace Crate"],
  },
  rm: {
    op: "rm",
    group: "Write",
    summary: "Destroy an instance",
    positional: { required: ["path"] },
    examples: ["msync rm Workspace/Crate"],
  },
  mv: {
    op: "mv",
    group: "Write",
    summary: "Reparent an instance",
    positional: { required: ["from", "to"] },
    flags: { force: "allow a cross-service move" },
    examples: ["msync mv Workspace/Crate ReplicatedStorage"],
  },
  attr: {
    op: "attr",
    group: "Write",
    summary: "Attributes: ls, set, rm",
    positional: { required: ["path"], optional: ["action", "name", "value"] },
    examples: ["msync attr Workspace/Boss", "msync attr Workspace/Boss set tier elite"],
  },
  tag: {
    op: "tag",
    group: "Write",
    summary: "CollectionService tags: ls, add, rm",
    positional: { required: ["path"], optional: ["action", "name"] },
    examples: ["msync tag Workspace/Boss add enemy"],
  },
  select: {
    op: "select",
    group: "Write",
    summary: "Read or set the Studio selection",
    variadic: "paths",
    examples: ["msync select", "msync select Workspace/Boss"],
  },

  // -------------------------------------------------------------- runtime
  eval: {
    op: "eval",
    group: "Studio",
    summary: "Run Luau inside Studio",
    positional: { required: ["source"] },
    examples: ["msync eval 'return #workspace:GetChildren()'"],
  },
  logs: {
    op: "logs",
    group: "Studio",
    summary: "Recent Studio output",
    flags: { level: "info | warn | error", limit: "how many lines" },
    examples: ["msync logs --level warn"],
  },
  undo: { op: "undo", group: "Studio", summary: "Undo the last change" },
  redo: { op: "redo", group: "Studio", summary: "Redo the last undone change" },
  save: { op: "save", group: "Studio", summary: "Ask Studio to save the place" },
  ping: { op: "ping", group: "Studio", summary: "Round-trip the plugin and report latency" },

  // -------------------------------------------------------------- capture
  photo: {
    op: "photo",
    group: "Capture",
    timeoutMs: 120000,
    summary: "Capture the Studio viewport as a PNG",
    flags: {
      out: "output file (default ./capture.png)",
      region: "x,y,width,height to crop in the viewport",
      delay: "seconds to wait before the frame is taken",
    },
    examples: ["msync photo --out shot.png", "msync photo --region 0,0,512,512 --out crop.png"],
  },
  authorize: {
    op: "capture_authorize",
    group: "Capture",
    timeoutMs: 60000,
    summary: "Ask Studio for screen capture permission",
  },

  // ------------------------------------------------------------- playtest
  playtest: {
    op: "playtest_start",
    group: "Playtest",
    summary: "Start a playtest (play, run, or multiplayer)",
    positional: { optional: ["mode"] },
    flags: { players: "PlayClients in multiplayer mode (1-8)" },
    timeoutMs: 30000,
    examples: ["msync playtest", "msync playtest multiplayer --players 2"],
  },
  playing: { op: "playtest_status", group: "Playtest", summary: "Is a playtest running, and which contexts are up" },
  stop: { op: "playtest_stop", group: "Playtest", summary: "End the running playtest" },
  run: {
    op: "playtest_exec",
    group: "Playtest",
    summary: "Run Luau inside a playtest context",
    positional: { required: ["source"] },
    flags: { context: "server (default) or client" },
    timeoutMs: 30000,
    examples: ["msync run 'return #game.Players:GetPlayers()'", "msync run --context client 'return 1'"],
  },

  // ------------------------------------------------------------- transfer
  copy: {
    op: "clipboard_copy",
    group: "Transfer",
    summary: "Copy instances to the cross-project clipboard",
    variadic: "paths",
    examples: ["msync copy Workspace/Boss", "msync copy   # uses the Studio selection"],
  },
  paste: {
    op: "clipboard_paste",
    group: "Transfer",
    summary: "Paste the clipboard into the connected place",
    positional: { optional: ["to"] },
    examples: ["msync paste", "msync paste ReplicatedStorage"],
  },

  // ---------------------------------------------------------------- local
  capabilities: { op: "capabilities", group: "Info", summary: "What this plugin and Studio can do" },
  status: { local: "status", group: "Info", summary: "Daemon, plugin, and project status" },
  projects: { local: "projects", group: "Info", summary: "List known projects" },
  commands: { local: "commands", group: "Info", summary: "Machine-readable command registry" },
  verse: { local: "verse", group: "Deen", summary: "Today's verse" },
  help: { local: "help", group: "Info", summary: "Show this help" },
};

/** Groups, in the order help should print them. */
export const GROUPS = ["Navigate", "Write", "Studio", "Capture", "Playtest", "Transfer", "Info", "Deen"];

/** The registry an agent reads. Derived, never hand-maintained. */
export function registry() {
  return {
    schemaVersion: 1,
    commands: Object.entries(COMMANDS).map(([name, spec]) => ({
      name,
      group: spec.group,
      summary: spec.summary,
      op: spec.op ?? null,
      positional: spec.positional ?? (spec.variadic ? { variadic: spec.variadic } : null),
      flags: spec.flags ?? null,
      examples: spec.examples ?? [],
    })),
  };
}

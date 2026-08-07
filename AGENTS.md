# MuslimSync

Drives a running Roblox Studio from the command line: read and write the live
DataModel, capture the viewport, and run Luau inside a real playtest.

Requires the MuslimSync app running (it hosts the daemon on port 7900) and a
Studio place open with the plugin connected. `msync status` says whether both
are true; check it first if anything else fails.

## Commands

### Navigate

| Command | Does |
| --- | --- |
| `get <path> [prop]` | Read an instance, or one property of it |
| `ls [path]` | List the children of an instance |
| `tree [path]` | Print a subtree |
| `props <path>` | Print an instance's readable properties |
| `source <path>` | Print a script's source, including unsaved editor drafts |
| `query <selector>` | Match a selector against the live tree |
| `find` | Find descendants by class and/or name |

### Write

| Command | Does |
| --- | --- |
| `set <path> <prop> <value>` | Set one property |
| `new <class> [parent] [name]` | Create an instance |
| `rm <path>` | Destroy an instance |
| `mv <from> <to>` | Reparent an instance |
| `attr <path> [action] [name] [value]` | Attributes: ls, set, rm |
| `tag <path> [action] [name]` | CollectionService tags: ls, add, rm |
| `select [paths...]` | Read or set the Studio selection |

### Studio

| Command | Does |
| --- | --- |
| `eval <source>` | Run Luau inside Studio |
| `logs` | Recent Studio output |
| `undo` | Undo the last change |
| `redo` | Redo the last undone change |
| `save` | Ask Studio to save the place |
| `ping` | Round-trip the plugin and report latency |

### Capture

| Command | Does |
| --- | --- |
| `photo` | Capture the Studio viewport as a PNG |
| `authorize` | Ask Studio for screen capture permission |

### Playtest

| Command | Does |
| --- | --- |
| `playtest [mode]` | Start a playtest (play, run, or multiplayer) |
| `playing` | Is a playtest running, and which contexts are up |
| `stop` | End the running playtest |
| `run [source]` | Run Luau inside a playtest context |
| `test <file>` | Run a Luau file in a fresh playtest and report pass or fail |

### Transfer

| Command | Does |
| --- | --- |
| `copy [paths...]` | Copy instances to the cross-project clipboard |
| `paste [to]` | Paste the clipboard into the connected place |

### Info

| Command | Does |
| --- | --- |
| `capabilities` | What this plugin and Studio can do |
| `status` | Daemon, plugin, and project status |
| `projects` | List known projects |
| `commands` | Machine-readable command registry |
| `help` | Show this help |
| `agents` | Print the agent brief, or install it into a project's AGENTS.md |

### Deen

| Command | Does |
| --- | --- |
| `verse` | Today's verse |

## Conventions worth knowing

- **Paths** are `/`-separated from the DataModel root: `Workspace/Baseplate`.
  An empty path is the DataModel itself.
- **Selectors** in `query` take `**` for any depth, and match a Name *or* a
  ClassName: `msync query 'StarterGui/**/TextButton'`.
- **Typed properties take the string you would type.** `Position 0,6,0`,
  `Color 255,0,0`, `Color '#3b82f6'`, `Size 4,1,2`, `Material Neon`. The plugin
  reads the type already in the property and converts. Do not hand-build
  `{"__type":"Vector3"}` for the CLI.
- **`set Parent` is refused** — use `mv`, which does the same thing with the
  checks that make it safe.
- **Every write is one undo step.** A failed write is rolled back rather than
  half-applied.
- **Reads are free and cheap.** Prefer `ls`/`tree`/`query` over `eval` for
  anything you could look up; `eval` runs arbitrary code in the user's open
  place.

## Exit codes

Branch on these rather than parsing prose.

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | fine | — |
| 2 | bad usage | fix the command; `msync help <cmd>` |
| 3 | no plugin connected | ask the user to open a place in Studio |
| 4 | the plugin refused | read the message; it names the cause |
| 5 | no daemon | ask the user to start the MuslimSync app |
| 6 | a test failed | the place is wrong, not the tool |

## Playtests

`msync test <file.luau>` starts a playtest, runs the file inside it, stops the
playtest whatever happens, and exits 0 or 6.

The verdict convention is Lua's own: **a script that returns without throwing
passes, `assert` fails.** A returned table comes back as JSON. Use
`--context client` for client-side checks and `--mode multiplayer --players N`
for replication.

## Adding a command

A folder with a `command.json` and one of `run.js`, `run.luau`, or
`workflow.json` becomes a CLI verb, an app button, and a registry entry at
once. Put it in `<project>/.muslimsync/commands/` to scope it to one project.
See `commands/` for one of each kind.

## Getting more detail

This file is deliberately short. For a command's flags and examples:

```bash
msync help <command>      # human-readable
msync commands --raw      # the whole registry as JSON
```

## Do not

- Do not run `eval` or `test` against a place the user has not told you to
  touch. Both execute code in whatever Studio has open right now.
- Do not fabricate a place's state. If a read fails, say so — the DataModel is
  live and the user can see it too.

# MuslimSync

Drives a running Roblox Studio from the command line: read and write the live
DataModel, capture the viewport, and run Luau inside a real playtest.

Requires the MuslimSync app running and a Studio place open with the plugin
connected. `msync status` says whether both are true; `msync doctor` says what
to do when they are not. Check one of them first if anything else fails.

The daemon answers on a unix socket as well as on port 7900, and the CLI
prefers the socket — so this works from shells that sandbox loopback
networking, where connecting to 127.0.0.1 fails with EPERM whatever the port.

## Working on this repo

```bash
npm run check                     # tests, plugin lint, file-size gate, this file's drift gate
npm run build:plugin -- --install # build the plugin into Studio's plugins folder
npm run gen:agents                # regenerate the tool section below
npm link                          # puts `msync` on PATH; without it, node cli/msync.js
aftman install                    # stylua and selene at the versions aftman.toml pins
```

**Run `npm run check` before committing, not after.** It has caught a red gate
twice in this project's history, both times after the commit had already landed.

- **No Rust is written.** Argon is vendored as a prebuilt binary in
  `vendor/argon/`. The sync engine is not ours to modify.
- **Files are capped at 400 lines**, enforced by `scripts/check-file-size.mjs`
  with an explicit grandfather list. Split by responsibility, not by line count.
- **Studio does not hot-reload plugins.** After `build:plugin --install` you
  must restart Studio, or you are testing the previous build. This has produced
  more than one phantom bug report.
- **Verify Roblox APIs before using them.** Several plausible-sounding ones do
  not exist — `HttpService:Base64Encode`, `ChangeHistoryService:CanUndo`,
  `PluginConnectionService:Connect`, `PluginConnection.MessageReceived`. Grep
  a working plugin for the real name; it settles in one look and guessing has
  cost hours.
- **Wire identifiers keep Argon's name on purpose**: `x-argon-token`,
  `argonId`, `~/.argon/`, `rbxasset://argon/`, `ArgonEmpty`. Renaming them
  breaks compatibility with the vendored binary. The product name is
  `plugin/src/Version.luau`.
- **`plugin/wally.toml`'s version is load-bearing.** The server refuses to sync
  on a major.minor mismatch.
- **AGENTS.md is generated.** Edit `cli/agents.js`, then `npm run gen:agents`.
  `npm run check` fails if the committed copy is stale.
- **Do not verify the app with `npx electron .`.** It launches Electron's own
  bundle, so the Dock and menu bar say "Electron" until someone notices and
  restarts it. To drive the real app over CDP:
  `open dist/MuslimSync.app --args --remote-debugging-port=9333` — branded and
  debuggable. `npm run start:dev` is the raw form and is for terminal logs.
- macOS arm64 is the only platform vendored or tested.

## Commands

### Navigate

| Command | Does |
| --- | --- |
| `get <path> [prop]` | Read an instance, or one property of it |
| `ls [path]` | List the children of an instance |
| `tree [path]` | Print a subtree |
| `props <path>` | Print an instance's readable properties |
| `source <path>` | Print a script's source — for unsynced places and unsaved drafts |
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
| `ping` | Round-trip the plugin and report latency |

### Transfer

| Command | Does |
| --- | --- |
| `copy [paths...]` | Copy instances to the cross-project clipboard |
| `paste [to]` | Paste the clipboard into the connected place |

### Also available

Not spelled out here. `msync help <group>` lists any of these in full.

| Group | Commands |
| --- | --- |
| Capture | `photo`, `authorize` |
| Playtest | `playtest`, `playing`, `stop`, `run`, `test` |
| Sync | `sync`, `changes`, `accept`, `cancel`, `connect`, `disconnect` |
| Info | `capabilities`, `status`, `projects`, `commands`, `doctor`, `help`, `new-command`, `map`, `agents` |
| Deen | `verse` |

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
- **Read scripts from disk, not through Studio.** In a synced project every
  script is already a file — open it with your normal file tools. `msync source`
  costs a round trip per file, cannot be grepped across, and hands you a second
  copy of the thing you are about to edit on disk. Use it only for what is not
  on disk: an unsynced place, or a draft the user has not saved yet.
- **Never read or write `.Source` through `eval`.** Files are the only source
  of truth for code in a synced project. Going around the `source` guard with
  `eval` gets you a stale second copy and edits that sync will overwrite.
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
| 5 | cannot reach the daemon | read the message — "is the app running?" and "a sandbox is blocking loopback" are different failures |
| 6 | a test failed | the place is wrong, not the tool |
| 7 | the setup is broken | run `msync doctor`; it says what to fix |

## Turning commands off

A project can disable commands in `.muslimsync/config.json`
(`commands.disable`, or `commands.only` for an allowlist). Anything disabled
is absent from this file and from `msync commands`, so if a command is listed
here it is available.

## Adding a command

A folder with a `command.json` and one of `run.js`, `run.luau`, or
`workflow.json` becomes a CLI verb, an app button, and a registry entry at
once. `msync new-command <name>` scaffolds a working one into this project's
`.muslimsync/commands/` (or `~/.muslimsync/commands/` with `--global`, for
every project); `--kind` picks `luau`, `node`, or `workflow`. See
`commands/` for one of each kind.

## Taking something from another game

The clipboard lives in the daemon, not in Studio, so it is not tied to one
place. Neither place has to be a project, and with both open there is no
switching at all — `msync status` lists what is connected and the `--place`
to name it:

```bash
msync status                                       # see what is open
msync copy ServerScriptService/QuestSystem --place 1
msync paste ServerScriptService --place 2
```

Several paths at once also work, and `msync copy` with no path takes whatever
is selected in Studio. With only one place open, `--place` can be left off.

**Anything that changes a place refuses to run without `--place` when more
than one is connected.** It is not advice; the command exits 2 and lists the
identifiers. The default target is whichever place connected most recently, so
the user opening another place in Studio silently moves it — which is fine for
a read and not fine for a write.

Select by identifier, never by name: every unpublished place is called
"Place1". `msync status` prints the `--place` value for each.

It is a real .rbxm round-trip through SerializationService, so what lands is the
exact instances — scripts with their source, properties, and everything nested
inside them — not something rebuilt from a description. Copying a parent and one
of its children inserts that child once, not twice.

The clipboard is in memory: restarting the app empties it. Copy, switch, paste.

**Reach for this before rebuilding anything by hand.** If the user wants a
system that already exists in another place of theirs, copying it is both exact
and faster than recreating it with `new` and `set`.

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

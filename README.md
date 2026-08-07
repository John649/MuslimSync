# MuslimSync

Roblox Studio, driven from the command line — with the sync engine from
[Argon](https://argon.wiki) underneath and the useful ideas from Ro Sync on top.

Nothing compiles to a binary. The app is Electron, the daemon is Node, the plugin
is Luau, and `msync` is a script. `npm start` is the whole install.

```bash
npm install
npm run build:plugin -- --install   # builds the plugin into Studio's plugins folder
npm start                           # launches the app, which hosts the daemon
```

`npm start` launches through Electron's own bundle, so macOS calls the app
"Electron" and gives it Electron's icon. For a real Dock entry:

```bash
npm run make:app     # builds dist/MuslimSync.app
```

That bundle is a shortcut, not a distributable: it points back at this checkout,
so editing `app/` takes effect on the next launch with nothing to rebuild.
Nothing is compiled — it is a folder with a plist in it. Drag it to the Dock or
to Applications.

Then open a place in Studio. The plugin connects to the daemon on port 7900, and
`msync` starts answering.

```bash
node cli/msync.js status
```

Symlink it onto your PATH if you want the short form:

```bash
ln -s "$PWD/cli/msync.js" /usr/local/bin/msync
```

## What it does

The design and the reasoning behind it are in [PLAN.md](PLAN.md). In short:

- **Two-way sync** — Argon's, vendored and unmodified. Files on disk, instances in
  Studio, either direction.
- **A command line for the DataModel** — read, write, navigate, query, and run Luau
  in the live place without touching the Studio UI.
- **Capture** — the viewport as a PNG, optionally framed on one instance.
- **Playtests as tests** — run a Luau file inside a real playtest and get an exit
  code back.
- **Custom commands** — drop a folder in, get a CLI verb.
- **A verse of the day**, in the app and in the notification.

## The command line

`msync help` lists everything; `msync help <command>` explains one. A tour of the
parts worth knowing:

```bash
msync ls Workspace                        # navigate
msync get Workspace/Baseplate Size
msync tree StarterGui --depth 3
msync query 'StarterGui/**/TextButton'    # ** matches any depth

msync set Workspace/Part Position 0,6,0   # write
msync set Workspace/Part Color '#3b82f6'
msync set Workspace/Part Material Neon
msync new Part --parent Workspace --name Boss
msync copy Workspace/Boss && msync paste ReplicatedStorage
```

Typed properties take the string you would actually type. `Position 0,6,0`,
`Color 255,0,0`, `Color '#3b82f6'`, and `Material Neon` all work — the plugin reads
the type already in the property and converts to it.

### Capture

```bash
msync photo --out shot.png
msync photo --subject Workspace/Boss --out boss.png    # frames the camera on it
msync photo --subject Workspace/Boss --margin 2        # more air around it
```

`--subject` points the camera at the instance's bounding box, takes the shot, and
puts the camera back where it was — including if the capture fails.

### Playtests

`msync test` runs a Luau file inside a real playtest: live DataModel, spawned
player, real replication.

```bash
msync test checks/spawn.luau
msync test checks/hud.luau --context client
msync test checks/net.luau --mode multiplayer --players 2
```

The verdict convention is Lua's own — **a script that returns without throwing
passes, `assert` fails.** A returned table comes back as JSON.

```lua
-- checks/spawn.luau
local Players = game:GetService("Players")

local player = Players:GetPlayers()[1] or Players.PlayerAdded:Wait()
local character = player.Character or player.CharacterAdded:Wait()
local humanoid = character:WaitForChild("Humanoid", 10)

assert(humanoid, "the character spawned without a Humanoid")
assert(humanoid.Health > 0, "the character spawned dead")

return { player = player.Name, health = humanoid.Health }
```

```
$ msync test checks/spawn.luau
PASS  server
{ "player": "Malt_WasHere", "health": 100 }
```

The playtest is stopped whatever happens, so a failing test never leaves Studio
stuck in play mode.

For an interactive session instead of a one-shot verdict:

```bash
msync playtest              # start
msync run 'return #game.Players:GetPlayers()'
msync run --script probe.luau --context client
msync stop
```

### Exit codes

Branch on these rather than parsing prose.

| Code | Meaning |
| --- | --- |
| 0 | fine |
| 2 | bad usage |
| 3 | no plugin connected |
| 4 | the plugin refused |
| 5 | no daemon — is the app running? |
| 6 | a test failed |

## Custom commands

A command is a folder with a `command.json` and a handler. Dropping one in gives
you the CLI verb, the app button, and the agent registry entry at once — the
registry is the implementation, not a parallel set of docs.

Looked up nearest-first, so a project can override a global:

```
<project>/.muslimsync/commands/    →    ~/.muslimsync/commands/    →    commands/
```

Three kinds of handler:

- `run.js` — Node, gets `{ args, ctx, log }`; `ctx.op(name, args)` is the same op
  surface the CLI uses, and nothing more.
- `run.luau` — runs in Studio through the ordinary `eval` op, with `args` in scope.
- `workflow.json` — a list of steps, where a later step can reference an earlier
  result by `$id.value.path` and the JSON type survives the hop.

See [`commands/`](commands) for one of each.

## Development

```bash
npm run check          # tests, plugin lint, file-size gate
npm run dev:plugin     # rebuild and reinstall the plugin on change
npm run build:quran    # regenerate quran/quran.json from source
```

Files are capped at 400 lines by `scripts/check-file-size.mjs`, with an explicit
grandfather list. The cap is there to keep a file readable in one sitting.

## Known limits

- **macOS arm64 only.** That is the only Argon binary vendored in `vendor/argon`,
  and the Windows path has never been run. Nothing is known to be wrong with it;
  it is untested, which is a different thing.
- Studio does not hot-reload a local plugin. After `build:plugin --install`,
  restart Studio for the new build to load.
- **A universe's name is not readable from Studio.** Not on the DataModel, not
  on StudioService, and not in the product info table — so the daemon fetches it
  from Roblox instead. That works for public universes; a private one returns a
  placeholder, and the create dialog falls back to the place's own name. It is
  the one thing that reaches the network, it is skipped entirely for unpublished
  places, and failing it costs nothing but a less specific default.
- Every unpublished place reports `placeId 0`, so sessions are keyed by connection
  rather than by place. Several scratch places can be open at once and stay
  distinct.

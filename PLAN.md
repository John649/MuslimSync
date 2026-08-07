# MuslimSync — design plan

> Argon does the syncing. MuslimSync adds the control plane, the desktop app,
> and the agent tooling — all in JavaScript and Luau. No Rust is written, and
> nothing is compiled to a binary.

---

## 1. What the two codebases actually gave us

### Argon (`argon-server` @ `fs-config`, `argon-roblox-fresh` @ `fs-config`)

Argon is the good part. It is ~12.7k lines of Rust doing one thing well:

| Piece | Where | Why it stays |
| --- | --- | --- |
| Two-way sync engine | `src/core/{tree,processor,snapshot,meta}.rs` | Real diffing, real identity tracking, real syncback |
| Middleware | `src/middleware/*.rs` (17 formats) | `.luau`, `.json`, `.toml`, `.csv`, `.md`, `.rbxm`, `.rbxmx`, `.meta.json`, JSON models |
| Project format | `src/project.rs` | Rojo-compatible `*.project.json` |
| Sync protocol | `src/server/*.rs` | `/details` `/subscribe` `/ws/{id}` `/write` `/snapshot` `/exec` `/stop` |
| Plugin sync client | `argon-roblox/src/{Client,Core}` | 693 lines total. Clean. |

Your fork already added, on top of upstream:

- a **master daemon** (`src/cli/master.rs`, 1083 lines) — project registry, `/projects`,
  `/startProject`, `/createProject`, `/browse`, `/mkdir`, project-root locking
- **shared-token auth** (`src/auth.rs`) on every mutating route
- a **WebSocket push channel** (`src/server/ws.rs`) replacing the `/read` long poll
- `/setConfig`, `/claimPlace`, `/sessions`
- and on the plugin side: a project **Picker**, **CreateProject**, **AddProject**,
  **ProjectDetails**, directory browsers, master-based discovery, log shipping

That master daemon is the thing MuslimSync's Electron app replaces. Everything
else in your fork stays exactly as it is.

### Ro Sync (`ro-sync` @ `pr-17`)

Ro Sync is 75k lines of Rust daemon + 12k-line `Plugin.luau` + a Tauri shell. The
ideas are excellent; the execution is what you called it. Evidence:

- `http_apply.rs` — 7,892 lines. `http.rs` — 6,604. `main.rs` — 6,055.
- `plugin/Plugin.luau` — **12,252 lines in one file**.
- `http_tests.rs` — 9,337 lines, plus `tier2_tests.rs` at 4,041.
- `docs/commands/*.json` is a 62-file command registry that is **documentation only** —
  it describes commands that are hand-written separately in `cli.rs` (2,453 lines).
  Two sources of truth, kept in sync by a checker script.

But these subsystems are genuinely worth taking, as *designs*, not as code:

| Subsystem | Ro Sync source | What's good about it |
| --- | --- | --- |
| Photo capture | `plugin/Photo.luau` (1,616) | Renders isolated models / exact camera / UI subtrees with **no screenshot permission**, transparent background, tight alpha crop |
| Playtest agent | `plugin/Playscript.luau` (1,755) + `daemon/src/playtest_run.rs` (2,090) | `playtest.emit/done/fail/signal/await` API, PlayServer + N PlayClients, NDJSON event stream, distinct exit codes |
| DataModel nav | `daemon/src/query.rs`, `path_resolver.rs` | `get/set/ls/tree/query/find/props/source/meta` over a live tree; `**` glob selectors |
| Cross-project clipboard | `plugin/Clipboard.luau` (542) | `SerializationService:Serialize/DeserializeInstancesAsync` + artifact transport |
| Artifact transport | `daemon/src/artifact.rs` (1,811) | Leased, chunked, hash-checked binary channel so a 4K PNG isn't one WS frame |
| Workflow schema | `daemon/src/workflow.rs` (1,688) | Versioned multi-step plans with `$step.value.x` references and assertions |
| Project bootstrap | `daemon/src/project_init.rs` (1,038) | Studio "Create Project" button → broker → slugged folder under an authorized root |
| Command registry | `docs/commands/*.json` | Machine-readable command surface for agents |

**The one idea in Ro Sync worth stealing outright** is the artifact-lease pattern
and the `SerializationService` round-trip — because together they mean we never
need an `.rbxm` parser in JavaScript. Studio serializes and deserializes for us.

### The size difference, measured

| | Argon | Ro Sync |
| --- | ---: | ---: |
| Sync/daemon (Rust) | 12,712 | 75,242 |
| — of which tests | — | 13,378 |
| Own support crates (Rust) | 512 | — |
| Studio plugin (Luau) | 11,266 | 22,564 |
| — of which vendored libs | 2,162 | — |
| Desktop shell (Rust) | — | 6,671 |
| Frontend (JS/CSS/HTML) | — | 15,242 |
| **Total** | **~24,500** | **~119,700** |

Ro Sync is roughly **5× the size of Argon** and does less syncing — it mirrors four
classes to disk where Argon handles seventeen file formats. That ratio is the whole
argument for this plan: build on the 24k-line codebase and port the good ideas out of
the 120k-line one, rather than the reverse.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  MuslimSync.app  (Electron — one process, no compile step) │
│                                                            │
│   Renderer                    Main process                 │
│   • project list / create     • control daemon (Node)      │
│   • connection status         • spawns `argon serve` per   │
│   • capture + playtest UI       project as a child proc    │
│   • verse of the day          • daily verse notification   │
└──────────────┬──────────────────────────┬──────────────────┘
               │ ws://127.0.0.1:7900      │ spawn
               │ (control protocol)       ▼
               │                   ┌──────────────────┐
               │                   │  argon serve     │  ← prebuilt, unmodified
               │                   │  :7878+          │     Rust binary
               │                   └────────┬─────────┘
               │                            │ argon sync protocol
               ▼                            ▼
        ┌────────────────────────────────────────────┐
        │      MuslimSync Studio plugin (Luau)       │
        │   fork of argon-roblox                     │
        │   • Argon sync client  (unchanged)         │
        │   • Control client     (new)               │
        │   • Photo / Playscript / Clipboard (ported)│
        └────────────────────────────────────────────┘

        `msync` CLI (Node) ──ws──> control daemon :7900
```

### The three rules this architecture enforces

1. **Argon is a black box.** We ship the binary you already built
   (`argon-server/target/release/argon`, 2.0.28) vendored into the app. We never
   `cargo build`. If Argon ever needs a change, that's a separate, deliberate decision —
   not something the normal dev loop touches.
2. **Sync and control are different channels.** Argon owns files↔DataModel. MuslimSync
   owns "read the tree, set a property, take a photo, run a playtest, tail logs."
   They never share state. A control-channel bug can't corrupt a sync.
3. **Everything we write is JS or Luau.** `npm install` pulls zero native modules.
   PNG encoding uses Node's built-in `zlib` (an encoder is ~80 lines). WebSockets use
   `ws` (pure JS). Electron itself is a prebuilt download.

---

## 3. Repository layout

```
MuslimSync/
├── package.json                  # workspaces: app, daemon, cli, plugin
├── vendor/
│   └── argon/{darwin-arm64,windows-x86_64,linux-x86_64}/argon
├── daemon/                       # Node control daemon (also embedded in Electron)
│   ├── index.js                  # server bootstrap, port claim, registry
│   ├── protocol.js               # frame schema + validation (single source of truth)
│   ├── ops/                      # ONE FILE PER OP FAMILY
│   │   ├── tree.js               #   get set ls tree props source find query
│   │   ├── mutate.js             #   new rm mv attr tag call select waypoint
│   │   ├── reflect.js            #   classinfo enums enum capabilities
│   │   ├── exec.js               #   eval, logs
│   │   ├── capture.js            #   photo prepare/read/close → PNG
│   │   ├── playtest.js           #   run/start/poll/cancel
│   │   └── clipboard.js          #   copy paste
│   ├── artifacts.js              # leased chunked binary transport
│   ├── argon.js                  # child-process lifecycle for `argon serve`
│   ├── projects.js               # registry, create, adopt, roots
│   └── commands/                 # custom-command loader (§5.3)
├── cli/
│   ├── msync.js                  # arg parsing → op dispatch. Thin.
│   └── format.js                 # human vs --raw rendering
├── app/                          # Electron
│   ├── main.js                   # embeds daemon/, spawns argon, notifications
│   ├── preload.js                # narrow contextBridge surface. No shell access.
│   └── renderer/
│       ├── views/{projects,connection,capture,playtest,commands,settings}.js
│       └── quran/                # verse of the day (§5.8)
├── plugin/                       # fork of argon-roblox
│   └── src/
│       ├── Control/              # NEW — control-channel client
│       │   ├── init.luau         #   socket, hello, request router
│       │   ├── Handlers/         #   one file per op family, mirrors daemon/ops/
│       │   ├── Value.luau        #   tagged value encode/decode
│       │   ├── Photo.luau        #   ported from ro-sync
│       │   ├── Playscript.luau   #   ported from ro-sync
│       │   └── Clipboard.luau    #   ported from ro-sync
│       └── (everything else unchanged from your argon-roblox fork)
├── quran/
│   ├── quran.json                # Uthmani text + translation, offline
│   └── daily.js                  # deterministic date → verse selection
└── commands/                     # built-in custom commands (§5.3)
```

### Anti-sloppiness rules, enforced in CI

These exist because of what we found in Ro Sync. They are lint gates, not vibes.

- **400-line hard cap per source file.** No exceptions. `Plugin.luau` at 12,252
  lines is what happens without this.
- **One source of truth for the command surface.** `daemon/ops/*` exports its own
  schema; the CLI, the Electron UI, the generated `COMMANDS.md`, and the agent-facing
  JSON registry are all *derived* from it. Ro Sync's checker-script-keeps-two-lists-in-sync
  approach is banned.
- **Tests live next to what they test.** `ops/tree.test.js`, not a 9,337-line
  `http_tests.rs`.
- **A new op is not done until it has:** a schema entry, a handler, a test, and a
  doc string. The generator fails the build if any is missing.
- **No prose protocol doc.** `PROTOCOL.md` is generated from `protocol.js`.

---

## 4. The control protocol

Deliberately one tenth the size of Ro Sync's protocol 6. JSON text frames both ways
over one WebSocket — Studio can send text frames (Argon's own `ws.rs` notes this).

```jsonc
// plugin → daemon, once
{"t":"hello","protocol":1,"placeId":"123","gameId":"456","pluginVersion":"1.0.0"}

// daemon → plugin
{"t":"req","id":42,"op":"get","args":{"path":"Workspace/Part"}}

// plugin → daemon
{"t":"res","id":42,"ok":true,"value":{"class":"Part"}}
{"t":"res","id":43,"ok":false,"error":{"code":"NOT_FOUND","message":"…"}}

// plugin → daemon, unsolicited
{"t":"event","kind":"log","level":"warn","message":"…","seq":881}
```

Error codes: `UNKNOWN_OP` `NOT_FOUND` `INVALID_ARGUMENT` `CONFLICT` `TIMEOUT`
`PERMISSION_REQUIRED` `PLUGIN_ERROR`. `--raw` callers branch on the code.

**Tagged values** — copied verbatim from Ro Sync's table because it's correct and
already proven against Studio:

| Roblox | JSON |
| --- | --- |
| `Vector3` | `{"__type":"Vector3","x":0,"y":0,"z":0}` |
| `Color3` | `{"__type":"Color3","r":1,"g":1,"b":1}` |
| `UDim2` | `{"__type":"UDim2","x":{"scale":0,"offset":0},"y":{…}}` |
| `CFrame` | `{"__type":"CFrame","components":[12 numbers]}` |
| `EnumItem` | `{"__type":"EnumItem","enum":"Material","name":"Plastic"}` |
| `Instance` | `{"__type":"Instance","path":"Workspace/Part","class":"Part"}` |

Primitives pass through. A decode failure returns an error — never a substituted default.

**Binary never rides the WebSocket.** PNGs and `.rbxm` buffers go through the
artifact lease over plain HTTP:

```
POST /artifacts/lease           → {id, token}
POST /artifacts/:id/chunk       → base64, must append at the exact next offset
POST /artifacts/:id/finalize    → verifies size + SHA-256, promotes the staging file
GET  /artifacts/:id             → bounded chunk read
POST /artifacts/:id/consume     → one-shot, then deleted
```

---

## 5. The features

### 5.1 CLI — `msync`

A Node script. `msync` connects to the control daemon, sends one op, prints the
result. Human output by default, `--raw` for JSON.

```
Project      init  new  adopt  ls  serve  stop  status  doctor
Navigate     get  set  ls  tree  props  source  find  query  where  meta  services
Mutate       new  rm  mv  attr  tag  call  select  waypoint  undo  redo  save
Reflect      classinfo  enums  enum  capabilities
Studio       eval  logs  tail  ping
Transfer     copy  paste            ← cross-project, via SerializationService
Capture      photo  screen  scene
Playtest     run  start  status  logs  ui  input  capture  stop
Commands     commands  run  <any custom command name>
Deen         verse
```

Cross-project copy/paste, exactly as you liked it in Ro Sync:

```bash
msync copy Workspace/Map/Boss          # in the source project
msync paste --to Workspace/Imported    # in the destination project
```

`copy` asks the plugin to `SerializationService:SerializeInstancesAsync` the roots
(one call, so cross-references survive), uploads the opaque buffer through an
artifact lease, and installs it in `~/.muslimsync/clipboard`. `paste` leases it to
the destination daemon and calls `DeserializeInstancesAsync` inside one
`ChangeHistoryService` recording — one Undo reverses the whole paste.

Non-obvious payoff: this same mechanism means **we never write an `.rbxm` parser in
JavaScript.** Studio is the serializer.

### 5.2 UI + scene capture

Port `ro-sync/plugin/Photo.luau` (1,616 lines) into `plugin/src/Control/Photo/`,
split across ~5 files to respect the line cap. It needs no screenshot permission and
loads nothing from the open place.

```bash
msync photo --focus Workspace/Map/Boss --view isometric \
            --size 1024x1024 --background transparent -o boss.png

msync photo --ui-target StarterGui/HUD/ShopFrame --ui only -o shop.png

msync photo --camera-cframe "$(msync get --path Workspace/Camera --prop CFrame --raw)" -o exact.png
```

Behaviours worth keeping from the original: isolated subject clones without scripts;
transparent background tight-crops to the subject's rendered alpha; camera, Lighting,
and in-game UI state are restored in a `pcall` cleanup after both success *and*
failure.

Node side: plugin returns tightly packed RGBA8 in bounded chunks; the daemon
validates `byteLength === width * height * 4`, then encodes a PNG with `zlib.deflate`.
No image dependency.

### 5.3 Custom commands — the extensibility layer

This is the piece Ro Sync got half-right (a registry that only generates docs) and
where MuslimSync should be genuinely better: **the registry is the implementation.**

A command is a folder, discovered from three roots in priority order:

```
./.muslimsync/commands/        project-local
~/.muslimsync/commands/        user-global
<app>/commands/                built-in
```

```
commands/screenshot-all-guis/
├── command.json
└── run.js
```

```jsonc
// command.json
{
  "name": "screenshot-all-guis",
  "description": "Photograph every ScreenGui in StarterGui to ./captures/",
  "category": "Capture",
  "args": {
    "out": { "type": "path", "default": "./captures", "help": "Output directory" },
    "size": { "type": "string", "default": "1024x1024" }
  },
  "surfaces": ["cli", "app", "agent"]
}
```

Three interchangeable implementation styles:

| File | Runs where | For |
| --- | --- | --- |
| `run.js` | Node, gets `ctx` | Anything with real logic, loops, file output |
| `run.luau` | Studio, via the exec op | Things easier said in Luau against the DataModel |
| `workflow.json` | Declarative step list | Deterministic multi-step plans with `$step.value.x` refs |

`ctx` in `run.js` is the same typed op client the CLI uses:

```js
export default async function ({ args, ctx, log }) {
  const guis = await ctx.query("StarterGui/*", { class: "ScreenGui" });
  for (const gui of guis) {
    log(`capturing ${gui.name}`);
    await ctx.photo({ uiTarget: gui.path, ui: "only", size: args.size,
                      out: `${args.out}/${gui.name}.png` });
  }
  return { captured: guis.length };
}
```

Registering a folder gets you, for free and simultaneously:

- `msync screenshot-all-guis --out ./shots` in the CLI
- a button in the Electron app's Commands view, with a form generated from `args`
- an entry in the generated `COMMANDS.md` and `commands.json` that a coding agent reads
- `--help` with the arg schema

This is the "like skills" ask: drop a folder in, it exists everywhere. No rebuild,
no registration list to edit, no second source of truth.

The `workflow.json` style reuses Ro Sync's schema shape (`daemon/src/workflow.rs`) —
versioned steps, `$stepId.value.properties.Name` references, assertions, and
transaction groups that map to one Studio change-history recording — but as a
*command format*, not a separate `rosync run` subsystem.

### 5.4 Playtest agent

Port `plugin/Playscript.luau` + the `playtest_run` state machine. The design is right;
it just needs to be a tenth the size.

```bash
msync playtest run --script ./bench.server.luau \
                   --client-script ./join.client.luau \
                   --mode multiplayer --players 2 \
                   --args '{"map":"Lighthouse","laps":3}' --raw
```

The playscript API, unchanged — it's a good API:

```lua
playtest.args        playtest.mode       playtest.context     playtest.jobId
playtest.emit(v)     playtest.log(msg)   playtest.done(v)     playtest.fail(msg)
playtest.signal(name, payload)           playtest.await(name, timeout)
playtest.awaitClients(count, timeout)
```

Mechanics kept: the edit-mode plugin is the only daemon client; playtest DataModel
clones talk back through `PluginConnectionService`; frames are authenticated with a
session token injected via `StudioTestService` test args, so a stale generation can't
inject events into a new run; `--raw` streams NDJSON; distinct exit codes per outcome
(pass / fail / timeout / aborted). Runtime changes never enter the sync pipeline.

Mechanics dropped: the 64-entry content-fingerprinted idempotency map, the
two-minute terminal replay window, the tombstone table. A caller-supplied `runId`
with a simple "already running → return the existing job" check covers the real case.

Lower-level `playtest start/exec/ui/input/capture/stop` stay available for custom
orchestration, including from a `run.js` custom command.

### 5.5 DataModel navigation, exec, logs

Straight ports into `daemon/ops/tree.js` + `plugin/src/Control/Handlers/`.

```bash
msync tree --path ReplicatedStorage --depth 3
msync query 'StarterGui/**/TextButton' --format paths
msync get --path Workspace/Camera --prop FieldOfView
msync set --path Workspace/Camera --prop FieldOfView --value 80 --waypoint "camera pass"
msync find --class ProximityPrompt
msync classinfo --class Humanoid --category Appearance
msync logs --tail --level warn
msync eval --file ./fixup.luau
```

Guardrails kept from Ro Sync, because they're correct: `set Parent` is refused with a
pointer to `msync mv` (it is the single easiest way to corrupt a DataModel);
cross-service moves require `--force`; `--waypoint` brackets a batch of writes so one
Ctrl-Z reverses the whole thing; every write lands in an append-only local log.

`query` selectors use `*` for one segment and `**` for zero or more, bounded by match
count, node budget, wall clock, and response bytes, with a machine-readable
`truncationReason`. That bounding is one of the genuinely well-done parts of Ro Sync.

`logs` is a ring buffer of `LogService` messages held plugin-side, drained by cursor.

### 5.6 Project setup and navigation

This is where the Electron app replaces your `master.rs`. Same flows, no Rust.

**From the app:** pick a Projects root → project list with per-project serve toggles →
Create Project (name + folder, with a directory browser) → Add Existing (paste or browse).
Each served project gets its own `argon serve` child process on its own port; the app
tracks them in a registry at `~/.muslimsync/registry.json` (canonical path, port, PID,
boot id — a stale PID is never enough authority to kill a process).

**From Studio:** the plugin's Connect page finds no daemon for the open place, so it
offers **Create Project**. It posts place metadata — `{gameName, placeName, gameId,
placeId, creatorType, creatorId}`, never a path — to the app's broker port. The app
derives a slug, creates exactly one direct non-symlink child under the authorized
Projects root, scaffolds `default.project.json` + `src/`, starts `argon serve`, and the
plugin reconnects. Existing `gameId` is idempotent; a name collision gets a
`-<gameId>` suffix; a second collision is refused with a suggested name.

That flow is `project_init.rs`'s design, which is the best-considered thing in Ro Sync.

**From the CLI:** `msync init`, `msync adopt <path>`, `msync ls`, `msync serve`.

### 5.7 Electron shell

- Single process. `app/main.js` requires `daemon/` in-process — the control daemon is
  not a separate binary. `node daemon/index.js` still runs it headless for CLI-only use.
- `preload.js` exposes a narrow `contextBridge` surface: project CRUD, folder picker,
  daemon ensure/stop, plugin install, settings. **No arbitrary shell command**, matching
  the boundary Ro Sync's `bridge.js` draws for the Tauri host.
- Ship as a plain checkout plus a launcher. `npm install && npm start`, and a
  double-clickable `MuslimSync.command` (macOS) / `MuslimSync.bat` (Windows) that runs
  `npx electron .`. `electron-builder` for a real `.app`/`.exe` is available later but
  is never on the critical path.
- **Plugin install** copies the built `MuslimSync.rbxm` into
  `~/Documents/Roblox/Plugins` (macOS) or `%LOCALAPPDATA%\Roblox\Plugins` (Windows).
  Building the plugin is `rojo build` — a `.rbxm`, not a binary.

### 5.8 Quran in the UI, and the daily reminder

Bundled offline at `quran/quran.json` — Uthmani Arabic + an English translation +
surah/ayah metadata. A few MB, no network, no API key, works on a plane.

**In the app.** A verse card, always present, at the top of the sidebar:

```
┌──────────────────────────────────────────────┐
│  ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ            │
│                                              │
│  "Read in the name of your Lord who created" │
│  Al-'Alaq 96:1                          ↻ ⧉  │
└──────────────────────────────────────────────┘
```

Arabic right-aligned in a proper Arabic face (bundle Amiri or Scheherazade so it
renders correctly on Windows too), translation below, reference beneath. `↻` draws a
new verse, `⧉` copies. Full text on click.

**Selection is deterministic per day** — everyone opening the app on the same date sees
the same verse, and reopening it doesn't reshuffle:

```js
// quran/daily.js
const index = hash(`${year}-${month}-${day}`) % verses.length;
```

**Daily reminder.** A configurable time (default 09:00) fires an Electron
`Notification` with the reference and the translation's first line; clicking it focuses
the app on the verse card. Settings: on/off, time, translation, and whether to show the
Arabic. The schedule survives restarts via `~/.muslimsync/settings.json` and re-arms on
`app.on('ready')` — if the machine was asleep past the trigger, it fires once on wake
rather than silently skipping the day.

**In the CLI.** `msync verse` prints the day's verse. It ships as a **built-in custom
command** (`commands/verse/`), so it doubles as the worked example of §5.3 that anyone
can read and copy.

---

## 6. Milestones

Each one ends somewhere usable. Nothing is a big-bang cutover.

| # | Milestone | Done when |
| --- | --- | --- |
| **0** | Skeleton | Repo, workspaces, vendored `argon` binary, `msync --version`, CI with the line-cap and registry gates |
| **1** | Control channel | Plugin fork connects to the Node daemon; `ping`, `capabilities`, `logs` round-trip. Argon sync still works untouched. |
| **2** | Navigation + mutation | `get set ls tree props source find query new rm mv attr tag call select waypoint eval` — the daily-driver surface |
| **3** | Electron shell | Projects root, project list, create/adopt, per-project `argon serve` lifecycle, connection status, **verse card + daily reminder** |
| **4** | Artifacts + capture | Lease transport, `Photo.luau` port, `msync photo`, capture view in the app |
| **5** | Copy / paste | `SerializationService` round-trip, cross-project clipboard |
| **6** | Custom commands | Loader, three implementation styles, generated registry + docs, CLI/app/agent surfaces, `commands/verse` as the reference example |
| **7** | Playtest agent | `Playscript.luau` port, `msync playtest run`, NDJSON stream, exit codes, playtest view in the app |
| **8** | Polish | `doctor`, `status`, agent-facing `AGENTS.md` generation, Windows pass |

Milestone 3 is the first point where the thing is genuinely nicer to use than Argon
alone. Milestones 1–3 are the ones worth doing carefully; 4–7 are ports of designs
that already work.

---

## 7. Decisions taken, and what would change them

| Decision | Why | Revisit if |
| --- | --- | --- |
| Vendor the prebuilt `argon` binary; write no Rust | You asked for no compile step, and the sync engine is the part that shouldn't be rewritten | Argon needs a protocol change we can't do plugin-side |
| Separate control channel from Argon's sync channel | A control bug can never corrupt a sync; Argon stays a black box | Never — this is the load-bearing decision |
| Studio serializes `.rbxm`, not us | Avoids writing a binary-format parser in JS entirely | Offline `.rbxl` building becomes a requirement (then: `argon build` shells out) |
| Registry *is* the implementation | Ro Sync's two-source-of-truth registry needs a CI script to stay honest | Never |
| 400-line file cap | `Plugin.luau` is 12,252 lines | Never |
| Full offline Quran text | Works with no network, no API key, no rate limit | Only if bundle size becomes a real problem |

---

## 8. Open items to settle before milestone 1

1. **CLI name.** `msync` is short and unclaimed; `muslimsync` as an alias. Confirm.
2. ~~**Plugin identity.**~~ **Settled:** one unified plugin. Fork
   `argon-roblox-fresh` into `plugin/`, rename `Argon` → `MuslimSync`, and add
   `src/Control/` alongside the existing `src/Client/` sync code. Two plugins would
   mean two toolbar buttons, two widgets, and two connection states for one project.
   Rename surface is small: 61 `script:FindFirstAncestor("Argon")` calls, the
   `default.project.json` name, `wally.toml`, and the built artifact name.
3. **Translation.** Which English translation to bundle (Sahih International reads
   most naturally for a UI card; Pickthall and Yusuf Ali are also public-text options).
4. **Windows.** Your Ro Sync PRs (#14, #16, #17) were largely Windows daemon/port/handle
   fixes. Worth folding those lessons into `daemon/argon.js` and the registry from day
   one rather than discovering them again.

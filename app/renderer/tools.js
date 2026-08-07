// The commands, capture and playtest views.
//
// Split from app.js so each file stays readable in one sitting; these three
// share nothing with the sync views except the api bridge and `channels`.

const api = window.muslimsync;

const channels = [...document.querySelectorAll(".channel")];

// ------------------------------------------------------------- commands

const cmd = {
  list: document.getElementById("command-list"),
  empty: document.getElementById("commands-empty"),
};

// Built with DOM calls: a command's name and description come off disk and are
// not ours to treat as markup.
function renderCommands({ commands }) {
  cmd.list.replaceChildren();

  const any = commands.length > 0;
  cmd.list.classList.toggle("is-hidden", !any);
  cmd.empty.classList.toggle("is-hidden", any);

  for (const command of commands) {
    const row = document.createElement("li");
    row.className = "cmd";

    const copy = document.createElement("span");
    copy.className = "cmd-copy";

    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = command.name;

    const description = document.createElement("span");
    description.className = "cmd-desc";
    description.textContent = command.description;

    const kind = document.createElement("span");
    kind.className = "cmd-kind";
    kind.textContent = command.kind;

    const run = document.createElement("button");
    run.className = "button";
    run.type = "button";
    // A command that declares required args cannot be run from a button with
    // nothing to type them into; the CLI is the honest answer there.
    const required = Object.entries(command.args ?? {}).filter(([, spec]) => spec.required);
    run.textContent = required.length ? "CLI only" : "Run";
    run.disabled = required.length > 0;
    run.title = required.length ? `needs --${required.map(([flag]) => flag).join(", --")}` : `msync ${command.name}`;

    run.addEventListener("click", async () => {
      run.disabled = true;
      const before = run.textContent;
      run.textContent = "…";

      try {
        await api.commands.run(command.name, {});
        run.textContent = "✓";
      } catch (error) {
        run.textContent = "failed";
        run.title = error.message;
      }

      setTimeout(() => {
        run.textContent = before;
        run.disabled = false;
      }, 1500);
    });

    copy.append(name, description);
    row.append(copy, kind, run);
    cmd.list.append(row);
  }
}

api.commands.list().then(renderCommands);

// The authoring brief: a self-contained page an AI assistant can act on. The
// main process owns the text and the clipboard; this side only shows and asks.
const brief = {
  copy: document.getElementById("brief-copy"),
  show: document.getElementById("brief-show"),
  text: document.getElementById("brief-text"),
};

brief.copy.addEventListener("click", async () => {
  const before = brief.copy.textContent;

  try {
    await api.commands.copyBrief();
    brief.copy.textContent = "Copied ✓";
  } catch {
    brief.copy.textContent = "failed";
  }

  setTimeout(() => {
    brief.copy.textContent = before;
  }, 1500);
});

brief.show.addEventListener("click", async () => {
  if (!brief.text.textContent) brief.text.textContent = await api.commands.brief();

  const hidden = brief.text.classList.toggle("is-hidden");
  brief.show.textContent = hidden ? "Show it" : "Hide it";
});

// -------------------------------------------------------------- capture

const shot = {
  subject: document.getElementById("capture-subject"),
  isolate: document.getElementById("capture-isolate"),
  take: document.getElementById("capture-take"),
  note: document.getElementById("capture-note"),
  frame: document.getElementById("capture-shot"),
  image: document.getElementById("capture-image"),
};

shot.take.addEventListener("click", async () => {
  const subject = shot.subject.value.trim();

  if (shot.isolate.checked && !subject) {
    shot.note.textContent = "an isolated render needs a subject to render";
    return;
  }

  shot.take.disabled = true;
  shot.note.textContent = "capturing — Studio may ask for permission…";

  try {
    const result = await api.capture.take({ subject: subject || undefined, isolate: shot.isolate.checked });

    // Cache-busted: successive captures write different files, but a viewer
    // that reuses the element would otherwise show the first one forever.
    shot.image.src = `${result.url}?t=${Date.now()}`;
    shot.frame.classList.remove("is-hidden");
    shot.note.textContent = `${result.width}×${result.height} — ${result.file}`;
  } catch (error) {
    shot.note.textContent = error.message.replace(/^Error invoking remote method '[^']+': /, "");
  } finally {
    shot.take.disabled = false;
  }
});

// ------------------------------------------------------------- playtest

const play = {
  mode: document.getElementById("playtest-mode"),
  players: document.getElementById("playtest-players"),
  start: document.getElementById("playtest-start"),
  stop: document.getElementById("playtest-stop"),
  note: document.getElementById("playtest-note"),
  context: document.getElementById("playtest-context"),
  source: document.getElementById("playtest-source"),
  run: document.getElementById("playtest-run"),
  output: document.getElementById("playtest-output"),
};

const clean = (error) => error.message.replace(/^Error invoking remote method '[^']+': /, "");

async function refreshPlaytest() {
  try {
    const status = await api.playtest.status();
    const names = (status.contexts ?? []).map((entry) => entry.name ?? entry);

    play.note.textContent = names.length ? `running — ${names.join(", ")}` : "Not running.";
    play.run.disabled = names.length === 0;
    play.stop.disabled = names.length === 0;
  } catch {
    // No plugin connected. The status bar already says so; repeating it here
    // would be two places to keep true.
    play.note.textContent = "Not running.";
    play.run.disabled = true;
    play.stop.disabled = true;
  }
}

play.mode.addEventListener("change", () => {
  play.players.disabled = play.mode.value !== "multiplayer";
});
play.players.disabled = true;

play.start.addEventListener("click", async () => {
  play.start.disabled = true;
  play.note.textContent = "starting…";

  try {
    await api.playtest.start({ mode: play.mode.value, players: Number(play.players.value) });
    // The contexts take a few seconds to check in, so the first look is early
    // on purpose and the poll below catches up.
    setTimeout(refreshPlaytest, 3000);
  } catch (error) {
    play.note.textContent = clean(error);
  } finally {
    play.start.disabled = false;
  }
});

play.stop.addEventListener("click", async () => {
  play.stop.disabled = true;
  play.note.textContent = "stopping…";

  try {
    await api.playtest.stop();
  } catch (error) {
    play.note.textContent = clean(error);
  }

  refreshPlaytest();
});

play.run.addEventListener("click", async () => {
  const source = play.source.value.trim();
  if (!source) return;

  play.run.disabled = true;
  play.output.classList.remove("is-hidden");
  play.output.textContent = "running…";

  try {
    const result = await api.playtest.run(source, play.context.value);

    play.output.textContent = result.ok === false
      ? result.error
      : typeof result.value === "object" && result.value !== null
        ? JSON.stringify(result.value, null, 2)
        : String(result.value ?? "nil");
  } catch (error) {
    play.output.textContent = clean(error);
  } finally {
    play.run.disabled = false;
  }
});

// Only while the view is open: polling a playtest the user is not looking at
// wakes the plugin every few seconds for nothing.
let playtestPoll = null;

for (const channel of channels) {
  channel.addEventListener("click", () => {
    clearInterval(playtestPoll);
    playtestPoll = null;

    if (channel.dataset.view === "playtest") {
      refreshPlaytest();
      playtestPoll = setInterval(refreshPlaytest, 4000);
    }
  });
}

// ------------------------------------------------- which commands a project has

const cfg = {
  project: document.getElementById("config-project"),
  note: document.getElementById("config-note"),
  list: document.getElementById("config-list"),
};

/** Fills the project picker. Disabled when there is nothing to configure. */
async function loadConfigProjects() {
  const { projects } = await api.projects.list();

  cfg.project.replaceChildren();
  cfg.project.disabled = projects.length === 0;

  if (!projects.length) {
    cfg.note.textContent = "No projects yet — commands are configured per project.";
    cfg.list.replaceChildren();
    return;
  }

  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.path;
    option.textContent = project.name;
    cfg.project.append(option);
  }

  await renderConfig();
}

// Built with DOM calls: a command's summary is ours, but the project path in
// the note comes off disk and is not ours to treat as markup.
async function renderConfig() {
  const projectPath = cfg.project.value;
  if (!projectPath) return;

  const { commands, allowlist, file } = await api.config.list(projectPath);

  cfg.list.replaceChildren();

  if (allowlist) {
    // Toggling would have to rewrite their allowlist as a blocklist, which
    // changes what they wrote rather than what they meant.
    cfg.note.textContent = `${file} uses commands.only — edit that file to change it.`;
    return;
  }

  const off = commands.filter((command) => !command.enabled).length;
  cfg.note.textContent = off ? `${off} turned off for this project` : "All commands available here";

  for (const command of commands) {
    const row = document.createElement("li");
    row.className = "cmd";

    const copy = document.createElement("span");
    copy.className = "cmd-copy";

    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = command.name;

    const summary = document.createElement("span");
    summary.className = "cmd-desc";
    summary.textContent = command.summary;

    const toggle = document.createElement("label");
    toggle.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = command.enabled;
    // Locked ones are how you find out what went wrong; a project that turned
    // off help and doctor would be one nobody could debug.
    input.disabled = command.locked;
    toggle.title = command.locked ? "always available" : `${command.enabled ? "disable" : "enable"} ${command.name}`;

    input.addEventListener("change", async () => {
      input.disabled = true;

      try {
        await api.config.set(projectPath, command.name, input.checked);
        await renderConfig();
      } catch (error) {
        cfg.note.textContent = error.message.replace(/^Error invoking remote method '[^']+': /, "");
        input.checked = !input.checked;
      } finally {
        input.disabled = command.locked;
      }
    });

    // The input is transparent; the track is the part you can see. Without it
    // the row renders as a toggle-shaped hole.
    const track = document.createElement("span");
    track.className = "switch-track";
    track.setAttribute("aria-hidden", "true");

    toggle.append(input, track);
    copy.append(name, summary);
    row.append(copy, toggle);
    cfg.list.append(row);
  }
}

cfg.project.addEventListener("change", renderConfig);
api.projects.onChange(loadConfigProjects);
loadConfigProjects();

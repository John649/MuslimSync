const api = window.muslimsync;

const TRANSLATION_NOTES = {
  khattab: "Modern English. The default on Quran.com.",
  pickthall: "Public domain, more archaic register.",
};

const el = {
  arabic: document.getElementById("verse-arabic"),
  translation: document.getElementById("verse-translation"),
  ref: document.getElementById("verse-ref"),
  theme: document.getElementById("verse-theme"),
  draw: document.getElementById("verse-draw"),
  copy: document.getElementById("verse-copy"),
  card: document.getElementById("verse"),
  statusLeft: document.getElementById("status-left"),
  dot: document.getElementById("daemon-dot"),
  rail: document.getElementById("rail-projects"),
  projectList: document.getElementById("project-list"),
  projectsEmpty: document.getElementById("projects-empty"),
};

// Captured before any swap so the icon can be restored exactly.
const copyIcon = el.copy.innerHTML;

let state = { verse: null, translation: "khattab", showArabic: true };

// Text always goes in via textContent, never innerHTML: the Quran text and the
// translations are data, and a card is not a place to run markup.
function render() {
  const { verse, translation, showArabic } = state;
  if (!verse) return;

  el.arabic.textContent = verse.verses.map((v) => v.arabic).join(" ");
  el.arabic.classList.toggle("is-hidden", !showArabic);

  el.translation.textContent = verse.verses.map((v) => v.translations[translation]).join(" ");
  el.ref.textContent = `${verse.surah.name} ${verse.ref}`;
  el.theme.textContent = verse.theme ?? "";
}

async function loadToday() {
  state = await api.verse.today();
  render();
}

el.draw.addEventListener("click", async () => {
  const pool = await api.verse.pool();
  const others = pool.filter((ref) => ref !== state.verse?.ref);
  const ref = others[Math.floor(Math.random() * others.length)];

  // Only the displayed verse changes — the day's verse is a property of the
  // date, so redrawing must not overwrite it in settings.
  state = { ...state, verse: { ...(await api.verse.draw(ref)), theme: null } };
  render();
});

el.copy.addEventListener("click", async () => {
  const { verse, translation } = state;
  if (!verse) return;

  const body = verse.verses.map((v) => v.translations[translation]).join(" ");
  await api.verse.copy(`${body}\n— ${verse.surah.name} ${verse.ref}`);

  el.copy.textContent = "✓";
  el.copy.classList.add("is-done");

  setTimeout(() => {
    el.copy.innerHTML = copyIcon;
    el.copy.classList.remove("is-done");
  }, 1200);
});

// Clicking the notification brings the window forward on today's verse, even
// if the user had drawn a different one earlier.
api.verse.onFocus(() => {
  loadToday();
  el.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ---------------------------------------------------------- daemon status

// The dot is green only when a plugin is actually answering. A listening
// daemon with nothing connected is not "online" from the user's point of view.
function renderStatus(status) {
  const connected = status.plugins?.length ?? 0;

  el.dot.classList.toggle("is-live", connected > 0);
  el.dot.title = connected > 0 ? `${connected} Studio place(s) connected` : "No Studio plugin connected";

  if (status.error) el.statusLeft.textContent = status.error;
  else if (connected > 0) el.statusLeft.textContent = connected === 1 ? "studio connected" : `${connected} places`;
  else if (status.listening) el.statusLeft.textContent = `waiting on :${status.port}`;
  else el.statusLeft.textContent = "daemon offline";

  renderRail(status.plugins ?? []);
}

// Discord-style initials: first letter of each of the first two words. An
// unnamed place (opened from a local file) falls back to its id, which is at
// least stable and identifies the right one when several are open.
function initials(plugin) {
  const words = String(plugin.placeName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return plugin.placeId.slice(-2);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

// One rail icon per connected place. Built with DOM calls rather than an HTML
// string: place names come from Studio and are not ours to trust as markup.
function renderRail(plugins) {
  el.rail.replaceChildren();

  for (const plugin of plugins) {
    const item = document.createElement("div");
    item.className = "rail-item";

    const pill = document.createElement("span");
    pill.className = "rail-pill";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-button";
    button.title = plugin.placeName ? `${plugin.placeName} (${plugin.placeId})` : `Place ${plugin.placeId}`;
    button.textContent = initials(plugin);

    item.append(pill, button);
    el.rail.append(item);
  }
}

api.daemon.onChange(renderStatus);
api.daemon.status().then(renderStatus);

// ------------------------------------------------------------- projects

// Built with DOM calls, not an HTML string: project names and paths come off
// the user's disk and are not ours to treat as markup.
function renderProjects({ projects }) {
  el.projectList.replaceChildren();

  const any = projects.length > 0;
  el.projectList.classList.toggle("is-hidden", !any);
  el.projectsEmpty.classList.toggle("is-hidden", any);

  for (const project of projects) {
    const row = document.createElement("li");
    row.className = "project";

    const dot = document.createElement("span");
    dot.className = `project-dot${project.running ? " is-serving" : ""}`;

    const copy = document.createElement("span");
    copy.className = "project-copy";

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;

    const meta = document.createElement("span");
    meta.className = "project-meta";
    meta.textContent = project.running ? `${project.host}:${project.port} — ${project.path}` : project.path;

    const state = document.createElement("span");
    state.className = "project-state";
    state.textContent = project.running ? "serving" : "idle";

    copy.append(name, meta);
    row.append(dot, copy, state);
    el.projectList.append(row);
  }
}

const loadProjects = () => api.projects.list().then(renderProjects);

api.projects.onChange(loadProjects);
loadProjects();

// ------------------------------------------------------------ navigation

const channels = [...document.querySelectorAll(".channel")];
const topbar = {
  name: document.getElementById("topbar-name"),
  note: document.getElementById("topbar-note"),
};

function show(view) {
  let page = null;

  for (const candidate of document.querySelectorAll(".page")) {
    const isTarget = candidate.id === `view-${view}`;
    candidate.classList.toggle("is-hidden", !isTarget);
    if (isTarget) page = candidate;
  }

  // Settings opens from the gear in the user panel, not from a channel, so
  // every channel deselects rather than one staying lit on the wrong view.
  for (const channel of channels) {
    channel.classList.toggle("is-active", channel.dataset.view === view);
  }

  topbar.name.textContent = view;
  topbar.note.textContent = page?.dataset.note ?? "";
}

for (const source of [...channels, ...document.querySelectorAll(".panel-button[data-view]")]) {
  source.addEventListener("click", () => show(source.dataset.view));
}

// -------------------------------------------------------------- settings

const controls = {
  enabled: document.getElementById("reminder-enabled"),
  time: document.getElementById("reminder-time"),
  translation: document.getElementById("translation"),
  translationHelp: document.getElementById("translation-help"),
  showArabic: document.getElementById("show-arabic"),
};

const pad = (n) => String(n).padStart(2, "0");

function showTranslationNote() {
  controls.translationHelp.textContent = TRANSLATION_NOTES[controls.translation.value] ?? "";
}

async function loadSettings() {
  const settings = await api.settings.get();

  controls.enabled.checked = settings.reminder.enabled;
  controls.time.value = `${pad(settings.reminder.hour)}:${pad(settings.reminder.minute)}`;
  controls.translation.value = settings.translation;
  controls.showArabic.checked = settings.showArabic;

  showTranslationNote();
}

async function saveReminder() {
  const [hour, minute] = controls.time.value.split(":").map(Number);

  // An empty time input yields NaN; keep the stored value rather than sending
  // one the main process would reject.
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;

  await api.settings.set({ reminder: { enabled: controls.enabled.checked, hour, minute } });
}

controls.enabled.addEventListener("change", saveReminder);
controls.time.addEventListener("change", saveReminder);

controls.translation.addEventListener("change", async () => {
  state = { ...state, translation: controls.translation.value };
  render();
  showTranslationNote();
  await api.settings.set({ translation: controls.translation.value });
});

controls.showArabic.addEventListener("change", async () => {
  state = { ...state, showArabic: controls.showArabic.checked };
  render();
  await api.settings.set({ showArabic: controls.showArabic.checked });
});

loadToday();
loadSettings();

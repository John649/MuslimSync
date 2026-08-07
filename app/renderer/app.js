const api = window.muslimsync;

const el = {
  arabic: document.getElementById("verse-arabic"),
  translation: document.getElementById("verse-translation"),
  ref: document.getElementById("verse-ref"),
  draw: document.getElementById("verse-draw"),
  copy: document.getElementById("verse-copy"),
  card: document.getElementById("verse"),
};

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
}

async function loadToday() {
  state = await api.verse.today();
  render();
}

async function drawAnother() {
  const pool = await api.verse.pool();
  const others = pool.filter((ref) => ref !== state.verse?.ref);
  const ref = others[Math.floor(Math.random() * others.length)];

  // Only the displayed verse changes — the day's verse is a property of the
  // date, so redrawing must not overwrite it in settings.
  state = { ...state, verse: await api.verse.draw(ref) };
  render();
}

el.draw.addEventListener("click", drawAnother);

el.copy.addEventListener("click", async () => {
  const { verse, translation } = state;
  if (!verse) return;

  const body = verse.verses.map((v) => v.translations[translation]).join(" ");
  await api.verse.copy(`${body}\n— ${verse.surah.name} ${verse.ref}`);

  el.copy.textContent = "✓";
  setTimeout(() => {
    el.copy.innerHTML = "&#8690;";
  }, 1200);
});

// Clicking the notification brings the window forward on today's verse, even
// if the user had drawn a different one earlier.
api.verse.onFocus(() => {
  loadToday();
  el.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ------------------------------------------------------------ navigation

for (const button of document.querySelectorAll(".nav-item")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".nav-item")) {
      other.classList.toggle("is-active", other === button);
    }
    for (const view of document.querySelectorAll(".view")) {
      view.classList.toggle("is-hidden", view.id !== `view-${button.dataset.view}`);
    }
  });
}

// -------------------------------------------------------------- settings

const controls = {
  enabled: document.getElementById("reminder-enabled"),
  time: document.getElementById("reminder-time"),
  translation: document.getElementById("translation"),
  showArabic: document.getElementById("show-arabic"),
};

const pad = (n) => String(n).padStart(2, "0");

async function loadSettings() {
  const settings = await api.settings.get();

  controls.enabled.checked = settings.reminder.enabled;
  controls.time.value = `${pad(settings.reminder.hour)}:${pad(settings.reminder.minute)}`;
  controls.translation.value = settings.translation;
  controls.showArabic.checked = settings.showArabic;
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
  await api.settings.set({ translation: controls.translation.value });
});

controls.showArabic.addEventListener("change", async () => {
  state = { ...state, showArabic: controls.showArabic.checked };
  render();
  await api.settings.set({ showArabic: controls.showArabic.checked });
});

loadToday();
loadSettings();

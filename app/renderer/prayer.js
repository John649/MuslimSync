// The prayer times card and its settings.
//
// Renders from `prayers:today`, re-renders when a prayer passes (the next
// marker has to move) and at midnight (the whole day has to). The countdown in
// the footer ticks once a minute — a live seconds counter is motion with no
// information in it.

const api = window.muslimsync;

const card = {
  root: document.getElementById("prayers"),
  list: document.getElementById("prayers-list"),
  next: document.getElementById("prayers-next"),
};

const controls = {
  enabled: document.getElementById("prayer-enabled"),
  location: document.getElementById("prayer-location"),
  locationHelp: document.getElementById("prayer-location-help"),
  method: document.getElementById("prayer-method"),
  asr: document.getElementById("prayer-asr"),
};

const NAMES = { fajr: "Fajr", sunrise: "Sunrise", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };

let timer = null;

function clock(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function countdown(iso) {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

async function render() {
  if (timer) clearTimeout(timer);

  const today = await api.prayers.today();

  if (!today.ready) {
    // No location yet — the main process is finding one; check back shortly.
    card.list.replaceChildren();
    card.next.textContent = "locating…";
    timer = setTimeout(render, 15000);
    return;
  }

  card.list.replaceChildren(
    ...Object.entries(today.times).map(([name, iso]) => {
      const item = document.createElement("li");
      item.className = "prayer-row";
      if (today.next?.name === name) item.classList.add("is-next");

      const label = document.createElement("span");
      label.textContent = NAMES[name] ?? name;

      const time = document.createElement("span");
      time.className = "prayer-time";
      time.textContent = clock(iso);

      item.append(label, time);
      return item;
    }),
  );

  card.next.textContent = today.next ? `${NAMES[today.next.name]} in ${countdown(today.next.time)}` : "";

  timer = setTimeout(render, 60000);
}

// ------------------------------------------------------------- settings

function patch(changes) {
  api.settings.get().then((current) => {
    // settings.update merges shallowly; the prayer object rides whole.
    api.settings.set({ prayer: { ...current.prayer, ...changes } }).then(render);
  });
}

async function loadSettings() {
  const { prayer } = await api.settings.get();

  controls.enabled.checked = prayer?.enabled !== false;
  controls.method.value = prayer?.method ?? "mwl";
  controls.asr.value = prayer?.asr ?? "standard";

  if (prayer?.location) {
    controls.location.value = `${prayer.location.latitude}, ${prayer.location.longitude}`;
  }
}

controls.enabled.addEventListener("change", () => patch({ enabled: controls.enabled.checked }));
controls.method.addEventListener("change", () => patch({ method: controls.method.value }));
controls.asr.addEventListener("change", () => patch({ asr: controls.asr.value }));

controls.location.addEventListener("change", () => {
  const parts = controls.location.value.split(",").map((part) => Number(part.trim()));

  const valid =
    parts.length === 2 &&
    parts.every(Number.isFinite) &&
    Math.abs(parts[0]) <= 90 &&
    Math.abs(parts[1]) <= 180;

  if (!valid) {
    controls.locationHelp.textContent = "Takes latitude, longitude — e.g. 21.42, 39.83";
    return;
  }

  controls.locationHelp.textContent = "Saved.";
  // A hand-set location outranks the IP guess; drop the stale city name.
  patch({ location: { latitude: parts[0], longitude: parts[1] }, city: null });
});

loadSettings();
render();

// `msync prayers` — today's times, the next one, and the settings behind them.
//
// Location, method and asr school live in ~/.muslimsync/settings.json under
// `prayer`, shared with the app: set once here, and the app's notifications
// use the same place and method. The app never guesses a location; this
// command is where one gets set — explicitly, or by asking the network once.

import { prayerTimes, nextPrayer, PRAYERS, METHODS } from "../quran/prayer.js";

/** "21.42,39.82" -> {latitude, longitude}, throwing on anything else. */
export function parseLocation(text) {
  const parts = String(text).split(",").map((part) => Number(part.trim()));

  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--location takes "latitude,longitude", got "${text}"`);
  }

  return { latitude: parts[0], longitude: parts[1] };
}

/**
 * Asks the network where we are, once. ip-api answers without a key and the
 * result is stored, so this runs at most one time per machine.
 */
async function locate() {
  const response = await fetch("http://ip-api.com/json/?fields=status,lat,lon,city", {
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();

  if (body.status !== "success") throw new Error("geolocation failed");

  return { location: { latitude: body.lat, longitude: body.lon }, city: body.city };
}

function clock(date) {
  if (!date) return "—";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The command. `settings` is the app's settings module, injected so tests can
 * hand in a fake instead of writing to the real home directory.
 */
export async function prayers({ flags, settings, log = () => {} }) {
  const patch = {};
  const current = settings.read();
  const stored = current.prayer ?? {};

  if (flags.location !== undefined) patch.location = parseLocation(flags.location);
  if (flags.method !== undefined) {
    if (!METHODS[flags.method]) throw new Error(`unknown method "${flags.method}" — one of: ${Object.keys(METHODS).join(", ")}`);
    patch.method = flags.method;
  }
  if (flags.asr !== undefined) {
    if (flags.asr !== "standard" && flags.asr !== "hanafi") throw new Error(`--asr takes standard or hanafi, got "${flags.asr}"`);
    patch.asr = flags.asr;
  }
  if (flags.reminders !== undefined) patch.enabled = flags.reminders !== false;

  let prayer = { ...stored, ...patch };

  if (!prayer.location) {
    // No location anywhere: ask the network once and keep the answer.
    const found = await locate();
    prayer.location = found.location;
    log(`located via IP: ${found.city} (${found.location.latitude.toFixed(2)}, ${found.location.longitude.toFixed(2)}) — override with --location "lat,lng"`);
  }

  if (Object.keys(patch).length > 0 || !stored.location) {
    settings.update({ prayer });
  }

  const now = flags.date ? new Date(`${flags.date}T12:00:00`) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--date takes YYYY-MM-DD, got "${flags.date}"`);

  const times = prayerTimes(
    { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    prayer.location,
    { method: prayer.method, asr: prayer.asr },
  );

  const next = flags.date
    ? null
    : nextPrayer(new Date(), prayer.location, { method: prayer.method, asr: prayer.asr, includeSunrise: false });

  const lines = PRAYERS.map((name) => {
    const marker = next && next.name === name && times[name]?.getTime() === next.time.getTime() ? "  ← next" : "";
    const label = name[0].toUpperCase() + name.slice(1);
    return `${label.padEnd(9)}${clock(times[name])}${marker}`;
  });

  if (next) {
    const minutes = Math.round((next.time.getTime() - Date.now()) / 60000);
    const label = next.name[0].toUpperCase() + next.name.slice(1);
    lines.push("", `${label} in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`);
  }

  return {
    json: {
      times: Object.fromEntries(PRAYERS.map((name) => [name, times[name]?.toISOString() ?? null])),
      next: next ? { name: next.name, time: next.time.toISOString() } : null,
      settings: prayer,
    },
    text: lines.join("\n"),
  };
}

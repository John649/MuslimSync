// Prayer notification scheduling for the app.
//
// Split from main.js for the line cap, and better off alone anyway: one timer
// armed at the next prayer, re-armed after it fires. `settings` and Electron's
// Notification are injected, so this file stays importable without Electron.

import { nextPrayer, prayerTimes, PRAYERS } from "../quran/prayer.js";

let prayerTimer = null;
let locating = false;

// No location stored: ask the network where we are, once, and keep the answer.
// A wrong city means wrong times, so the notification body names the city and
// the settings file is where to correct it.
async function locate(settings) {
  if (locating) return;
  locating = true;

  try {
    const response = await fetch("http://ip-api.com/json/?fields=status,lat,lon,city", {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (body.status !== "success") return;

    const current = settings.read().prayer ?? {};
    settings.update({
      prayer: { ...current, location: { latitude: body.lat, longitude: body.lon }, city: body.city },
    });
  } catch {
    // Offline: stay quiet and try again next arm.
  } finally {
    locating = false;
  }
}


// One timer armed at the next prayer. Unlike the daily verse there is no
// missed-day catch-up: a prayer notification three hours late is noise, so a
// sleep past one simply arms the next.
export function armPrayers(settings, Notification) {
  if (prayerTimer) {
    clearTimeout(prayerTimer);
    prayerTimer = null;
  }

  const { prayer } = settings.read();
  if (!prayer?.enabled) return;

  if (!prayer.location) {
    locate(settings).then(() => {
      if (settings.read().prayer?.location) armPrayers(settings, Notification);
    });
    return;
  }

  const next = nextPrayer(new Date(), prayer.location, {
    method: prayer.method,
    asr: prayer.asr,
    includeSunrise: false,
  });

  // Polar edge: nothing computable today or tomorrow. Try again in a day.
  if (!next) {
    prayerTimer = setTimeout(() => armPrayers(settings, Notification), 24 * 3600000);
    return;
  }

  prayerTimer = setTimeout(() => {
    const name = next.name[0].toUpperCase() + next.name.slice(1);
    const clock = next.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    new Notification({ title: `${name} — ${clock}`, body: "It is time to pray.", silent: false }).show();

    armPrayers(settings, Notification);
  }, Math.max(1000, next.time.getTime() - Date.now()));
}


/** Today's times for the UI: ISO stamps, the next prayer, and the settings. */
export function prayersToday(settings) {
  const prayer = settings.read().prayer ?? {};

  if (!prayer.location) return { ready: false, settings: prayer };

  const now = new Date();
  const times = prayerTimes(
    { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    prayer.location,
    { method: prayer.method, asr: prayer.asr },
  );
  const next = nextPrayer(now, prayer.location, {
    method: prayer.method,
    asr: prayer.asr,
    includeSunrise: false,
  });

  return {
    ready: true,
    times: Object.fromEntries(PRAYERS.map((name) => [name, times[name]?.toISOString() ?? null])),
    next: next ? { name: next.name, time: next.time.toISOString() } : null,
    settings: prayer,
  };
}

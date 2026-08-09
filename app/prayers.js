// Prayer notification scheduling for the app.
//
// Split from main.js for the line cap, and better off alone anyway: one timer
// armed at the next prayer, re-armed after it fires. `settings` and Electron's
// Notification are injected, so this file stays importable without Electron.

import { nextPrayer } from "../quran/prayer.js";

let prayerTimer = null;


// One timer armed at the next prayer. Unlike the daily verse there is no
// missed-day catch-up: a prayer notification three hours late is noise, so a
// sleep past one simply arms the next.
export function armPrayers(settings, Notification) {
  if (prayerTimer) {
    clearTimeout(prayerTimer);
    prayerTimer = null;
  }

  const { prayer } = settings.read();
  if (!prayer?.enabled || !prayer?.location) return;

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


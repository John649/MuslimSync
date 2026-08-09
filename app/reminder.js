// Daily reminder scheduling.
//
// Pure functions over an explicit `now`, so the awkward cases — the machine was
// asleep past the trigger, the app was closed all day, the user moved the time
// to earlier than it already is — are testable without waiting for a clock.
//
// The rule: fire at most once per local day, and if that day's trigger has
// already passed unfired, fire immediately rather than silently skipping the
// day. A reminder you never see is worse than one that arrives late.
//
// The armed timer lives at the bottom, split from main.js for the line cap the
// way prayers.js is: `settings`, Notification, and the window are injected, so
// the file stays importable without Electron and the rules stay pure.

import { verseOfTheDay, dayNumber } from "../quran/daily.js";

export const DEFAULT_TIME = { hour: 9, minute: 0 };

/** Validates and normalizes a {hour, minute}, throwing rather than clamping. */
export function parseTime(time) {
  const hour = Number(time?.hour);
  const minute = Number(time?.minute);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`reminder hour must be 0-23, got ${time?.hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`reminder minute must be 0-59, got ${time?.minute}`);
  }

  return { hour, minute };
}

/** The moment the reminder is due on the local day containing `now`. */
export function triggerOn(now, time) {
  const { hour, minute } = parseTime(time);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

/**
 * Whether to fire right now.
 *
 * `lastFiredDay` is a dayNumber, or null if the reminder has never fired. A
 * day whose trigger passed while the machine was asleep still counts as due —
 * that is the whole point of checking on wake rather than trusting a timer.
 */
export function shouldFire(now, time, lastFiredDay) {
  const today = dayNumber(now);

  if (lastFiredDay === today) return false;

  return now.getTime() >= triggerOn(now, time).getTime();
}

/**
 * When to next wake up and re-check, in milliseconds from `now`.
 *
 * Never returns 0 or a negative delay: a timer armed with those would spin. If
 * something is already due, the caller should have fired it via shouldFire.
 */
export function msUntilNextCheck(now, time, lastFiredDay) {
  const todaysTrigger = triggerOn(now, time);

  // Today's trigger is still ahead — wait for it.
  if (now.getTime() < todaysTrigger.getTime()) {
    return todaysTrigger.getTime() - now.getTime();
  }

  // Today's trigger has passed. If it never fired, it is due now; the caller
  // fires it and re-arms, so schedule the shortest sane retry rather than
  // sleeping until tomorrow with an unfired reminder outstanding.
  if (lastFiredDay !== dayNumber(now)) {
    return 1000;
  }

  // Fired already: wait for tomorrow's trigger. Built from calendar fields
  // rather than +24h so a DST shift lands on the right wall-clock time.
  const { hour, minute } = parseTime(time);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);

  return tomorrow.getTime() - now.getTime();
}

// ------------------------------------------------------------- the timer

let reminderTimer = null;

function fireReminder(settings, Notification, getWindow) {
  const verse = verseOfTheDay();
  const translation = settings.read().translation;
  const body = verse.verses.map((v) => v.translations[translation]).join(" ");

  const notification = new Notification({
    title: `${verse.surah.name} ${verse.ref}`,
    // One line is enough for a notification; the card has the whole thing.
    body: body.length > 180 ? `${body.slice(0, 177)}…` : body,
    silent: false,
  });

  notification.on("click", () => {
    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send("verse:focus");
    }
  });

  notification.show();

  settings.update({ lastReminderDay: dayNumber(new Date()) });
}

export function armReminder(settings, Notification, getWindow) {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }

  const current = settings.read();
  if (!current.reminder.enabled) return;

  const now = new Date();

  if (shouldFire(now, current.reminder, current.lastReminderDay)) {
    fireReminder(settings, Notification, getWindow);
  }

  // Re-read after a possible fire so the next delay accounts for it.
  const after = settings.read();
  const delay = msUntilNextCheck(new Date(), after.reminder, after.lastReminderDay);

  reminderTimer = setTimeout(() => armReminder(settings, Notification, getWindow), delay);
}

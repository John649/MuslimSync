// Persisted app settings.
//
// Deliberately tolerant on read and strict on write: a hand-edited or
// half-written settings file must not stop the app from opening, but it must
// also never silently discard a key it did not recognise.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_TIME, parseTime } from "./reminder.js";

export const DIR = path.join(homedir(), ".muslimsync");
const FILE = path.join(DIR, "settings.json");

export const DEFAULTS = {
  projectsRoot: path.join(homedir(), "projects"),
  controlPort: 7900,
  reminder: { enabled: true, ...DEFAULT_TIME },
  translation: "khattab",
  showArabic: true,
  lastReminderDay: null,
};

export function read() {
  let stored = {};

  try {
    stored = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // Missing or corrupt: fall back to defaults rather than refusing to start.
    return { ...DEFAULTS };
  }

  const merged = { ...DEFAULTS, ...stored, reminder: { ...DEFAULTS.reminder, ...(stored.reminder ?? {}) } };

  // A bad time would otherwise throw deep inside the scheduler at 9am.
  try {
    parseTime(merged.reminder);
  } catch {
    merged.reminder = { ...DEFAULTS.reminder, enabled: merged.reminder.enabled !== false };
  }

  return merged;
}

export function write(settings) {
  mkdirSync(DIR, { recursive: true });

  // Write-then-rename, so a crash mid-write cannot leave a truncated file that
  // the next start would silently reset to defaults.
  const temporary = `${FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2));
  renameSync(temporary, FILE);

  return settings;
}

export function update(patch) {
  return write({ ...read(), ...patch });
}

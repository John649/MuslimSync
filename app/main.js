import { app, BrowserWindow, ipcMain, Notification, powerMonitor, shell, clipboard } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verseOfTheDay, poolRefs, resolve, dayNumber } from "../quran/daily.js";
import { shouldFire, msUntilNextCheck } from "./reminder.js";
import * as settings from "./settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let window = null;
let reminderTimer = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.loadFile(path.join(HERE, "renderer", "index.html"));

  // Anything that wants to leave the app opens in the real browser rather than
  // navigating the renderer somewhere it has privileges.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ------------------------------------------------------------- the reminder

function fireReminder() {
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

function armReminder() {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }

  const current = settings.read();
  if (!current.reminder.enabled) return;

  const now = new Date();

  if (shouldFire(now, current.reminder, current.lastReminderDay)) {
    fireReminder();
  }

  // Re-read after a possible fire so the next delay accounts for it.
  const after = settings.read();
  const delay = msUntilNextCheck(new Date(), after.reminder, after.lastReminderDay);

  reminderTimer = setTimeout(armReminder, delay);
}

// --------------------------------------------------------------------- ipc

ipcMain.handle("verse:today", () => {
  const current = settings.read();
  return { verse: verseOfTheDay(), translation: current.translation, showArabic: current.showArabic };
});

ipcMain.handle("verse:draw", (_event, ref) => {
  // Used by the "another verse" control. An unknown ref is the caller's bug,
  // so let resolve throw rather than quietly substituting today's verse.
  return resolve(ref);
});

ipcMain.handle("verse:pool", () => poolRefs());

ipcMain.handle("verse:copy", (_event, text) => {
  clipboard.writeText(String(text));
  return true;
});

ipcMain.handle("settings:get", () => settings.read());

ipcMain.handle("settings:set", (_event, patch) => {
  const next = settings.update(patch ?? {});
  // A changed time or enabled flag must take effect now, not at the next
  // scheduled wake — otherwise turning the reminder on does nothing all day.
  armReminder();
  return next;
});

// ------------------------------------------------------------------ startup

app.whenReady().then(() => {
  createWindow();
  armReminder();

  // A laptop that slept through the trigger wakes here. The timer that was
  // pending during sleep is unreliable, so re-evaluate against the real clock.
  powerMonitor.on("resume", armReminder);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

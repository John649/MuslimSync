import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, shell, clipboard } from "electron";
import path from "node:path";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";

import { verseOfTheDay, poolRefs, resolve, dayNumber } from "../quran/daily.js";
import { Daemon } from "../daemon/index.js";
import { socketPath } from "../daemon/socket.js";
import { ArgonProcesses } from "../daemon/argon.js";
import { createRoutes } from "../daemon/routes.js";
import * as projects from "../daemon/projects.js";
import { Artifacts } from "../daemon/artifacts.js";
import { registerTools } from "./tools.js";
import { shouldFire, msUntilNextCheck } from "./reminder.js";
import * as settings from "./settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let window = null;
let reminderTimer = null;
let daemon = null;
let argon = null;
let artifacts = null;
// Held separately from daemon.status() so a failed start still has something
// to show: "port in use" is exactly what the user needs to see.
let daemonError = null;

// A bounded feed for the Activity view. Bounded because it runs for as long as
// the app does, and an unbounded array is a slow leak.
const MAX_ACTIVITY = 200;
const activity = [];

function record(kind, message) {
  activity.push({ at: Date.now(), kind, message });
  if (activity.length > MAX_ACTIVITY) activity.shift();
  window?.webContents.send("activity:changed");
}

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

// ------------------------------------------------------------- the daemon

// ------------------------------------------------------- watching the root

let rootWatcher = null;
let watchedRoot = null;
let watchTimer = null;

/**
 * Refreshes the project list when the projects folder changes on disk.
 *
 * The daemon announces the projects it creates itself, but a project can also
 * appear from `argon init`, from a git clone, or from someone making the folder
 * by hand — and an app that only notices its own work looks broken in exactly
 * those cases.
 */
function watchProjectsRoot() {
  const root = settings.read().projectsRoot;

  if (root === watchedRoot && rootWatcher) return;

  rootWatcher?.close();
  watchedRoot = root;

  try {
    rootWatcher = watch(root, { persistent: false }, () => {
      // Creating a project writes several files; one notification per change
      // would re-scan the disk a dozen times for a single create.
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => window?.webContents.send("projects:changed"), 150);
    });
  } catch {
    // A root that does not exist yet is not an error — the user has simply not
    // chosen one, and choosing one re-arms this.
    rootWatcher = null;
  }
}

function daemonStatus() {
  return { ...(daemon?.status() ?? { listening: false, port: null, plugins: [] }), error: daemonError };
}

/** Project paths argon is currently serving. Empty when nothing is synced. */
function servingPaths() {
  return [...(argon?.running ?? new Map()).keys()];
}

function publishStatus() {
  window?.webContents.send("daemon:status", daemonStatus());
  // Serving state is part of what the projects list shows, so the two are
  // refreshed together rather than leaving the list stale until a click.
  window?.webContents.send("projects:changed");
}

async function startDaemon() {
  const { controlPort } = settings.read();

  argon = new ArgonProcesses();
  artifacts = new Artifacts({ directory: path.join(settings.DIR, "artifacts") });
  // Anything left by a previous run is stale: leases do not survive a restart
  // and finalized bytes nobody consumed are just disk.
  artifacts.clear();

  try {
    daemon = new Daemon({
      port: controlPort,
      // A second front door for shells that sandbox loopback networking.
      socketFile: socketPath(settings.DIR),
      serving: servingPaths,
      // The plugin's project endpoints. Reading the root per request rather
      // than capturing it means changing it in Settings takes effect at once.
      routes: createRoutes({
        projectsRoot: () => settings.read().projectsRoot,
        argon,
        artifacts,
        log: (entry) => {
          console.log(`[plugin ${entry.level}] ${entry.source}: ${entry.message}`);
          record(entry.level, `${entry.source}: ${entry.message}`);
        },
        changed: () => window?.webContents.send("projects:changed"),
      }),
    });
    daemon.on("change", publishStatus);

    daemon.on("op", (event) => {
      const detail = event.ok
        ? event.note ?? `${event.ms}ms`
        : event.error;
      record(event.ok ? "op" : "error", `${event.op} — ${detail}`);
    });

    daemon.on("plugin-event", (event) => {
      record(event.kind, typeof event.payload?.message === "string" ? event.payload.message : event.kind);
    });
    // A plugin we cannot parse is worth surfacing rather than swallowing: it
    // almost always means a version mismatch between app and plugin.
    daemon.on("protocol-error", (error) => {
      daemonError = `plugin protocol error: ${error.message}`;
      record("error", error.message);
      publishStatus();
    });

    await daemon.start();
    daemonError = null;
  } catch (error) {
    daemon = null;
    daemonError =
      error.code === "EADDRINUSE"
        ? `port ${controlPort} is already in use — another MuslimSync may be running`
        : error.message;
  }

  publishStatus();
}

// --------------------------------------------------------------------- ipc

ipcMain.handle("daemon:status", () => daemonStatus());

ipcMain.handle("activity:list", () => [...activity].reverse());

ipcMain.handle("projects:list", () => {
  const { projectsRoot } = settings.read();
  return { root: projectsRoot, projects: projects.list(projectsRoot, { running: argon?.running ?? new Map() }) };
});

// Both folder buttons end at the same place — a projects root that gets
// scanned. "Add existing" differs only in that it takes the project itself and
// adopts its parent, because pointing at a project and getting an empty list is
// the mistake this app should absorb rather than report.
async function pickDirectory(title) {
  const result = await dialog.showOpenDialog(window, {
    title,
    properties: ["openDirectory", "createDirectory"],
    defaultPath: settings.read().projectsRoot,
  });

  return result.canceled ? null : result.filePaths[0];
}

ipcMain.handle("projects:chooseRoot", async () => {
  const directory = await pickDirectory("Choose a projects folder");
  if (!directory) return { ok: false, cancelled: true };

  settings.update({ projectsRoot: directory });
  watchProjectsRoot();
  publishStatus();

  return { ok: true, root: directory };
});

ipcMain.handle("projects:addExisting", async () => {
  const directory = await pickDirectory("Choose an existing project");
  if (!directory) return { ok: false, cancelled: true };

  if (!projects.isExistingProject(directory)) {
    return { ok: false, error: `${path.basename(directory)} has no .project.json in it` };
  }

  const root = projects.rootFor(directory);
  settings.update({ projectsRoot: root });
  watchProjectsRoot();
  publishStatus();

  return { ok: true, root };
});

ipcMain.handle("conflicts:list", async () => {
  const running = [...(argon?.running ?? new Map()).entries()];

  // Argon owns conflict state; this reads it rather than keeping a second
  // copy that could disagree with the thing actually syncing.
  const results = await Promise.all(
    running.map(async ([projectPath, session]) => {
      try {
        const response = await fetch(`http://${session.host}:${session.port}/details`, { signal: AbortSignal.timeout(2000) });
        return { path: projectPath, reachable: response.ok, port: session.port };
      } catch {
        return { path: projectPath, reachable: false, port: session.port };
      }
    }),
  );

  return results;
});

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

registerTools({
  // Read through getters: the daemon is replaced on restart, and a captured
  // reference would keep answering from the dead one.
  daemon: () => daemon,
  artifacts: () => artifacts,
  appRoot: path.join(HERE, ".."),
  directory: () => settings.DIR,
  record,
});

app.whenReady().then(async () => {
  createWindow();
  armReminder();
  watchProjectsRoot();
  await startDaemon();

  // The renderer may have finished loading before the daemon did.
  window?.webContents.on("did-finish-load", publishStatus);

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

// Release the port on the way out, or a relaunch hits EADDRINUSE against our
// own orphaned listener.
app.on("before-quit", async (event) => {
  if (!daemon) return;
  event.preventDefault();

  const closing = daemon;
  daemon = null;

  // Every argon serve we started is ours to clean up; leaving them running
  // would hold their ports and keep syncing with nothing watching.
  argon?.stopAll();
  await closing.stop();
  app.quit();
});

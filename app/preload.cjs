// The renderer's entire privileged surface.
//
// Deliberately a fixed list of named operations. There is no `invoke(channel)`
// passthrough and no shell access: a bug or an injected string in the renderer
// must not be able to reach anything the main process did not choose to expose.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("muslimsync", {
  verse: {
    today: () => ipcRenderer.invoke("verse:today"),
    draw: (ref) => ipcRenderer.invoke("verse:draw", ref),
    pool: () => ipcRenderer.invoke("verse:pool"),
    copy: (text) => ipcRenderer.invoke("verse:copy", text),
    onFocus: (handler) => {
      ipcRenderer.on("verse:focus", () => handler());
    },
  },
  daemon: {
    status: () => ipcRenderer.invoke("daemon:status"),
    onChange: (handler) => {
      ipcRenderer.on("daemon:status", (_event, status) => handler(status));
    },
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    chooseRoot: () => ipcRenderer.invoke("projects:chooseRoot"),
    rename: (path, name) => ipcRenderer.invoke("project:rename", path, name),
    serve: (path) => ipcRenderer.invoke("project:serve", path),
    stop: (path) => ipcRenderer.invoke("project:stop", path),
    reveal: (path) => ipcRenderer.invoke("project:reveal", path),
    map: (path) => ipcRenderer.invoke("project:map", path),
    addExisting: () => ipcRenderer.invoke("projects:addExisting"),
    onChange: (handler) => {
      ipcRenderer.on("projects:changed", () => handler());
    },
  },
  activity: {
    list: () => ipcRenderer.invoke("activity:list"),
    onChange: (handler) => {
      ipcRenderer.on("activity:changed", () => handler());
    },
  },
  commands: {
    list: () => ipcRenderer.invoke("commands:list"),
    run: (name, args) => ipcRenderer.invoke("commands:run", name, args),
    brief: () => ipcRenderer.invoke("commands:brief"),
    copyBrief: () => ipcRenderer.invoke("commands:copyBrief"),
  },
  config: {
    list: (projectPath) => ipcRenderer.invoke("config:list", projectPath),
    set: (projectPath, name, enabled) => ipcRenderer.invoke("config:set", projectPath, name, enabled),
  },
  capture: {
    take: (options) => ipcRenderer.invoke("capture:take", options),
  },
  playtest: {
    status: () => ipcRenderer.invoke("playtest:status"),
    start: (options) => ipcRenderer.invoke("playtest:start", options),
    stop: () => ipcRenderer.invoke("playtest:stop"),
    run: (source, context) => ipcRenderer.invoke("playtest:run", source, context),
  },
  conflicts: {
    list: () => ipcRenderer.invoke("conflicts:list"),
  },
  prayers: {
    today: () => ipcRenderer.invoke("prayers:today"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
});

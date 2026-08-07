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
  conflicts: {
    list: () => ipcRenderer.invoke("conflicts:list"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
});

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
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
});

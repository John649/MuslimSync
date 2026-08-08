// One project's settings.
//
// Split from app.js to keep both readable: this is a screen of its own, and it
// shares only the DOM, and talks to the list through events.

const api = window.muslimsync;

const el = {
  list: document.getElementById("project-list"),
  empty: document.getElementById("projects-empty"),
  detail: document.getElementById("project-detail"),
  back: document.getElementById("detail-back"),
  name: document.getElementById("detail-name"),
  path: document.getElementById("detail-path"),
  reveal: document.getElementById("detail-reveal"),
  sync: document.getElementById("detail-sync"),
  serve: document.getElementById("detail-serve"),
  identity: document.getElementById("detail-identity"),
  mapped: document.getElementById("detail-mapped"),
  map: document.getElementById("detail-map"),
};

// Which project's settings are open, or null for the list.
let openPath = null;

/** Shows one project's settings, or the list when nothing is selected. */
async function renderDetail() {
  const showing = openPath !== null;

  el.detail.classList.toggle("is-hidden", !showing);
  el.list.classList.toggle("is-hidden", showing);
  el.empty.classList.toggle("is-hidden", showing || undefined);

  if (!showing) return;

  const { projects } = await api.projects.list();
  const project = projects.find((candidate) => candidate.path === openPath);

  // The folder can be renamed or deleted from under us while this is open.
  if (!project) {
    openPath = null;
    await renderDetail();
    return;
  }

  el.name.value = project.name;
  el.path.textContent = project.path;

  el.sync.textContent = project.running
    ? `serving on ${project.host}:${project.port}`
    : "not serving";
  el.serve.textContent = project.running ? "Stop" : "Serve";

  el.mapped.textContent = (project.services ?? []).join(", ") || "none";
  el.map.disabled = false;

  const identity = [];
  if (project.gameId) identity.push(`game ${project.gameId}`);
  if (project.placeIds?.length) identity.push(`place ${project.placeIds.join(", ")}`);
  if (project.argonId) identity.push(`marker ${project.argonId.slice(0, 8)}`);

  el.identity.textContent = identity.length ? identity.join(" · ") : "not claimed by a place yet";
}

function openProject(path) {
  openPath = path;
  renderDetail();
}

el.back.addEventListener("click", () => {
  openPath = null;
  renderDetail();
});

el.reveal.addEventListener("click", () => api.projects.reveal(openPath));

el.map.addEventListener("click", async () => {
  el.map.disabled = true;

  const { added } = await api.projects.map(openPath);

  el.mapped.textContent = added.length
    ? `added ${added.join(", ")} — restart the sync so argon picks them up`
    : "already maps every code-bearing service";

  // Re-read rather than patch: the list is the source of truth for the panel.
  await renderDetail();
});

// Renaming on blur rather than on every keystroke: a rename per character
// would rewrite the project file a dozen times for one edit.
el.name.addEventListener("change", async () => {
  const name = el.name.value.trim();
  if (!name) return renderDetail();

  try {
    await api.projects.rename(openPath, name);
  } catch (error) {
    el.path.textContent = error.message.replace(/^Error invoking remote method '[^']+': /, "");
  }

  await renderDetail();
});

el.serve.addEventListener("click", async () => {
  const { projects } = await api.projects.list();
  const project = projects.find((candidate) => candidate.path === openPath);

  el.serve.disabled = true;
  el.sync.textContent = project?.running ? "stopping…" : "starting…";

  try {
    if (project?.running) await api.projects.stop(openPath);
    else await api.projects.serve(openPath);
  } catch (error) {
    el.sync.textContent = error.message.replace(/^Error invoking remote method '[^']+': /, "");
  } finally {
    el.serve.disabled = false;
  }

  await renderDetail();
});


document.addEventListener("project:open", (event) => openProject(event.detail));
document.addEventListener("projects:rendered", () => renderDetail());

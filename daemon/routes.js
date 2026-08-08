// The endpoints the Studio plugin's Discovery module calls.
//
// These replace `argon master`. They speak MsgPack because the plugin's
// transport (Client/Http.luau) already does, which means the plugin needs no
// changes at all — the smallest possible surface for a component we cannot yet
// watch running.
//
// Every path the plugin supplies is confined by projects.js/paths.js. The
// plugin never names a location we act on directly.

import { encode, decode } from "@msgpack/msgpack";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as projects from "./projects.js";
import { universeName, suggestName, suggestFolder } from "./universe.js";
import { renderSection } from "../cli/agents.js";
import { vendoredArgon } from "./argon.js";

// Must exceed a base64-encoded artifact chunk, which inflates by 4/3, plus the
// surrounding MsgPack map. At 256 KB this was smaller than one chunk, so every
// capture past a tiny region died on a 413 that surfaced as a hang.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Reads and decodes a MsgPack body, bounded so a bad caller cannot exhaust us. */
async function readBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
    chunks.push(chunk);
  }

  if (!total) return {};

  try {
    const decoded = decode(Buffer.concat(chunks));

    // Lua cannot tell an empty map from an empty array, and the plugin's
    // encoder resolves the tie as an array (MsgPack.luau: `length == mapLength`
    // means array, and both are 0 when empty). So `{path = nil}` — which is how
    // the browser asks for the project roots — arrives as []. Rejecting that as
    // "not a map" broke root browsing entirely.
    if (Array.isArray(decoded)) {
      if (decoded.length === 0) return {};
      throw new HttpError(400, "body must be a map");
    }

    if (decoded === null || typeof decoded !== "object") {
      throw new HttpError(400, "body must be a map");
    }

    return decoded;
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(400, "body is not valid MsgPack");
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, value) {
  const body = Buffer.from(encode(value));
  response.writeHead(status, { "content-type": "application/msgpack", "content-length": body.length });
  response.end(body);
}

/**
 * Builds the route table.
 *
 * `context` supplies the projects root and the argon process manager, so the
 * routes hold no state of their own and are straightforward to test.
 */
export function createRoutes({ projectsRoot, argon, artifacts, log = () => {}, changed = () => {} }) {
  // Artifact routes exist only when a store is supplied; the headless daemon
  // has no need for binary transport.
  const artifactRoutes = artifacts
    ? {
        "POST /artifacts/lease": async (body) =>
          artifacts.lease({ size: body.size, mime: body.mime, sha256: body.sha256 }),

        "POST /artifacts/chunk": async (body) =>
          artifacts.chunk(body.id, body.token, { offset: body.offset, dataBase64: body.data }),

        "POST /artifacts/finalize": async (body) => artifacts.finalize(body.id, body.token),

        "POST /artifacts/read": async (body) =>
          artifacts.read(body.id, { offset: body.offset, limit: body.limit }),

        "POST /artifacts/meta": async (body) => artifacts.metadata(body.id),
      }
    : {};

  /** Starts a project and returns the session the plugin should connect to. */
  async function serveProject(projectPath) {
    const session = await argon.start(projectPath);

    // Whether a project is serving is part of what the list shows, so the app
    // has to hear about it. Without this the only thing that ever refreshed the
    // list was a plugin connecting, and a project created from the plugin sat
    // invisible until something unrelated happened.
    changed();

    return { host: session.host, port: session.port };
  }

  return {
    ...artifactRoutes,

    "GET /projects": async () => projects.list(projectsRoot(), { running: argon.running }),

    // What to put in the create dialog's fields. The plugin supplies what only
    // Studio knows (the place's own title); the universe name is looked up
    // here, where there is network access.
    "POST /suggestName": async (body) => {
      const gameName = await universeName(body.gameId);
      const name = suggestName({ gameName, placeName: body.placeName });

      return { name, folder: suggestFolder(name), gameName, placeName: body.placeName ?? null };
    },

    "POST /browse": async (body) => projects.browse(projectsRoot(), body.path),

    "POST /mkdir": async (body) => projects.mkdir(projectsRoot(), body.path, body.name),

    "POST /log": async (body) => {
      // Fire and forget by contract: the plugin calls this from its own logger,
      // so anything thrown here could recurse. Never let it fail the request.
      log({
        level: String(body.level ?? "info"),
        message: String(body.message ?? ""),
        source: String(body.source ?? "unknown"),
      });
      return true;
    },

    "POST /startProject": async (body) => {
      if (!body.path) throw new HttpError(400, "path is required");

      // Confine it: the plugin echoes back a path we handed it, but a path from
      // a caller is still a path from a caller.
      const target = projects.resolveProjectPath(projectsRoot(), body.path);
      if (!projects.isExistingProject(target)) throw new HttpError(404, `no project at ${target}`);

      return serveProject(target);
    },

    "POST /createProject": async (body) => {
      const identity = { gameId: body.gameId, placeId: body.placeId, argonId: body.argonId };

      // Creating twice for one universe returns the existing project rather
      // than scaffolding a second copy of the same game.
      const existing = projects.findByIdentity(projects.list(projectsRoot(), { running: argon.running }), identity);

      if (existing) {
        return { ...(await serveProject(existing.path)), path: existing.path };
      }

      const planned = projects.plan(projectsRoot(), {
        name: body.name,
        dir: body.dir,
        folder: body.folder,
        gameId: body.gameId,
        argonId: body.argonId,
      });

      // An existing folder is adopted rather than refused — the fork's master
      // learned this too. A user who made the folder first should not be stuck.
      if (!projects.isExistingProject(planned.path)) {
        scaffold(planned.path);
      }

      projects.claim(planned.path, identity);

      // Announced before serving as well: the project exists on disk from here
      // on, and a serve that fails should not make it invisible.
      changed();

      return { ...(await serveProject(planned.path)), path: planned.path };
    },
  };
}

/**
 * Services that hold code, and where their files go.
 *
 * `argon init` maps three, which leaves ServerStorage — an ordinary home for
 * server modules — with no file behind it. Anything unmapped is invisible to
 * git, to grep, and to an agent's file tools, and the only way to read it is
 * through Studio.
 *
 * Workspace is deliberately absent. Mapping it serialises every part in the
 * place to disk: enormous, rewritten on every nudge of a model, and merge
 * conflicts nobody can read. Lighting and the other property-only services are
 * out for the same reason in miniature — they hold settings, not source.
 */
const CODE_SERVICES = {
  ServerStorage: "src/ServerStorage",
  ReplicatedFirst: "src/ReplicatedFirst",
  StarterGui: "src/StarterGui",
  StarterPack: "src/StarterPack",
};

/**
 * Adds the code-bearing services argon init leaves out.
 *
 * Only ever adds: a service already in the tree is one the user or argon
 * decided on, and overwriting it would move their files.
 */
function widenTree(projectPath) {
  // projectFileIn returns a full path, not a name — joining it again produces
  // a path that does not exist, and the catch below would swallow that whole.
  const file = projects.projectFileIn(projectPath);
  if (!file) return;

  try {
    const project = JSON.parse(readFileSync(file, "utf8"));
    let added = false;

    for (const [service, into] of Object.entries(CODE_SERVICES)) {
      if (project.tree?.[service]) continue;

      project.tree[service] = { $path: into };
      mkdirSync(path.join(projectPath, into), { recursive: true });
      added = true;
    }

    if (added) writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  } catch {
    // A project that argon wrote and we could not widen still syncs the three
    // services it came with, which is worse than intended and not broken.
  }
}

/** Scaffolds a project with the vendored argon, so it matches `argon init` exactly. */
function scaffold(projectPath) {
  const binary = vendoredArgon();
  if (!binary) throw new HttpError(500, `no vendored argon for ${process.platform}/${process.arch}`);

  const result = spawnSync(binary, ["init", projectPath, "--yes"], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new HttpError(500, `argon init failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
  }

  widenTree(projectPath);

  // A new project gets the agent brief without anyone remembering to ask.
  // An agent working in a game repository has no reason to know this tool
  // exists — `gh` is recognised because it is in the training data, and
  // nothing here is.
  try {
    writeFileSync(path.join(projectPath, "AGENTS.md"), renderSection());
  } catch {
    // A project without the brief is a project that still works. Failing the
    // create over a documentation file would be the wrong trade.
  }
}

/** Dispatches one request against the table, or returns false if unmatched. */
export async function handle(routes, request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const route = routes[`${request.method} ${url.pathname}`];

  if (!route) return false;

  try {
    const body = request.method === "POST" ? await readBody(request) : {};
    send(response, 200, await route(body));
  } catch (cause) {
    const status = cause instanceof HttpError ? cause.status : statusFor(cause);
    send(response, status, { error: cause.message, code: cause.code ?? null });
  }

  return true;
}

function statusFor(cause) {
  // A refused path is the caller's fault, not ours, and the plugin shows the
  // message — so it must not read as an internal error.
  if (cause.code === "PROJECT_PATH_ESCAPE" || cause.code === "INVALID_NAME") return 400;
  // ArtifactError already knows its status (404 unknown, 409 out of order,
  // 413 too large, 422 bad digest); reporting all of those as 500 would hide
  // which one happened.
  if (Number.isInteger(cause.status)) return cause.status;
  return 500;
}

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

import * as projects from "./projects.js";
import { vendoredArgon } from "./argon.js";

const MAX_BODY_BYTES = 256 * 1024;

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
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
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
export function createRoutes({ projectsRoot, argon, log = () => {} }) {
  /** Starts a project and returns the session the plugin should connect to. */
  async function serveProject(projectPath) {
    const session = await argon.start(projectPath);
    return { host: session.host, port: session.port };
  }

  return {
    "GET /projects": async () => projects.list(projectsRoot(), { running: argon.running }),

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

      return { ...(await serveProject(planned.path)), path: planned.path };
    },
  };
}

/** Scaffolds a project with the vendored argon, so it matches `argon init` exactly. */
function scaffold(projectPath) {
  const binary = vendoredArgon();
  if (!binary) throw new HttpError(500, `no vendored argon for ${process.platform}/${process.arch}`);

  const result = spawnSync(binary, ["init", projectPath, "--yes"], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new HttpError(500, `argon init failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
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
  return 500;
}

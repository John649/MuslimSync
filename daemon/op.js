// POST /op — one control call.
//
// Split from the daemon so index.js is about connections and this is about
// what comes down them. The clipboard lives on the daemon because it outlives
// any single call: copy in one place, paste in another.

import { ERROR, MAX_FRAME_BYTES } from "./protocol.js";

export async function handleOp(daemon, request, response) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_FRAME_BYTES) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }

  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  let call;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    reply(400, { ok: false, error: { code: ERROR.INVALID_ARGUMENT, message: "body is not valid JSON" } });
    return;
  }

  if (typeof call.op !== "string" || !call.op) {
    reply(400, { ok: false, error: { code: ERROR.INVALID_ARGUMENT, message: "op is required" } });
    return;
  }

  const args = { ...(call.args ?? {}) };

  // Paste with no artifact means "the last thing copied".
  if (call.op === "clipboard_paste" && !args.artifact) {
    if (!daemon.clipboard) {
      reply(200, {
        ok: false,
        error: { code: ERROR.NOT_FOUND, message: "the clipboard is empty — copy something first", retryable: false },
      });
      return;
    }
    args.artifact = daemon.clipboard;
  }

  // Studio plays one place at a time, for the whole application. Starting a
  // playtest while another place is already in play mode does nothing, reports
  // success, and leaves the caller waiting out a context timeout for something
  // that was never coming.
  if (call.op === "playtest_start") {
    const busy = [];

    for (const session of daemon.sessions) {
      const playing = await session.request("playtest_status", {}, { timeoutMs: 8000 }).catch(() => null);
      if (playing?.contexts?.length) busy.push(session);
    }

    if (busy.length) {
      const where = busy.map((session) => `${session.placeName ?? session.ref} (--place ${session.ref})`).join(", ");

      reply(200, {
        ok: false,
        error: {
          code: ERROR.CONFLICT,
          message: `Studio is already playing ${where} — stop that first; only one place can be in play mode`,
          retryable: false,
        },
      });
      return;
    }
  }

  try {
    const startedAt = Date.now();

    const value = await daemon.request(call.op, args, {
      placeId: call.placeId,
      timeoutMs: Number.isFinite(call.timeoutMs) ? call.timeoutMs : undefined,
    });

    if (call.op === "clipboard_copy" && value?.artifact) daemon.clipboard = value.artifact;

    // Every served op is emitted, which is what makes an activity view worth
    // opening: without it the feed only fills up when something goes wrong.
    daemon.emit("op", { op: call.op, ok: true, ms: Date.now() - startedAt });

    reply(200, { ok: true, value });
  } catch (cause) {
    daemon.emit("op", { op: call.op, ok: false, error: cause.message });
    // The plugin's own error codes reach the caller intact — the CLI branches
    // on them, so translating here would lose the distinction between
    // "not connected" and "the plugin said no".
    const status = cause.code === ERROR.NOT_CONNECTED ? 503 : 200;
    reply(status, {
      ok: false,
      error: { code: cause.code ?? ERROR.PLUGIN_ERROR, message: cause.message, retryable: cause.retryable === true },
    });
  }
}


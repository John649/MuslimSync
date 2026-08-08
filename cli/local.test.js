import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { local } from "./local.js";

/** A check file on disk, since `test` reads its source rather than taking it. */
function checkFile(source = "return 1") {
  const directory = mkdtempSync(path.join(tmpdir(), "msync-local-"));
  const file = path.join(directory, "check.luau");
  writeFileSync(file, source);
  return { file, directory };
}

/** Records what reached the daemon and answers each op plausibly. */
function recordingDaemon(seen) {
  return async (_port, _route, body) => {
    seen.push({ op: body.op, placeId: body.placeId });

    if (body.op === "playtest_status") return { contexts: [{ name: "server", kind: "server" }] };
    if (body.op === "playtest_exec") return { ok: true, value: "1" };

    return {};
  };
}

// Mirrors the real Fatal's (code, message) shape, so a message asserted on here
// is the message a user would actually see.
class Fatal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const HARNESS = { flags: {}, port: 0, Fatal, EXIT: {}, config: {} };

test("a test run sends every op to the place it was given", async () => {
  // The bug this covers: `test` is a local command, and the dispatcher used to
  // resolve the target *after* the local branch returned. So `--place <id>` was
  // parsed, accepted, and dropped, and all four ops went to whichever place
  // Studio had touched most recently — the run reported on a place nobody named.
  const { file, directory } = checkFile();
  const seen = [];

  try {
    await local("test", { ...HARNESS, positionals: [file], daemon: recordingDaemon(seen), placeId: "130505358256570" });

    assert.deepEqual(
      seen.map((call) => call.op),
      ["playtest_start", "playtest_status", "playtest_exec", "playtest_stop"],
    );

    // Every one of them, not just the exec: waiting for a context in one place
    // and running in another is the same bug wearing a different hat.
    assert.deepEqual([...new Set(seen.map((call) => call.placeId))], ["130505358256570"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a test run with no place named leaves the daemon to pick", async () => {
  const { file, directory } = checkFile();
  const seen = [];

  try {
    await local("test", { ...HARNESS, positionals: [file], daemon: recordingDaemon(seen) });

    assert.deepEqual([...new Set(seen.map((call) => call.placeId))], [undefined]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the stop still carries the place when the check itself fails", async () => {
  // The stop runs in a `finally`. If it went to the default place it would
  // leave the named one in play mode after a failure, which is the state that
  // blocks every later playtest.
  const { file, directory } = checkFile();
  const seen = [];

  const daemon = async (_port, _route, body) => {
    seen.push({ op: body.op, placeId: body.placeId });

    if (body.op === "playtest_status") return { contexts: [{ name: "server", kind: "server" }] };
    if (body.op === "playtest_exec") return { ok: false, error: "assertion failed" };

    return {};
  };

  try {
    await assert.rejects(
      () => local("test", { ...HARNESS, positionals: [file], daemon, placeId: "130505358256570" }),
      /assertion failed/,
    );

    const stop = seen.find((call) => call.op === "playtest_stop");
    assert.equal(stop?.placeId, "130505358256570");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

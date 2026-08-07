import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeFrame, encodeRequest, toError, ProtocolError, PROTOCOL, ERROR, MAX_FRAME_BYTES } from "./protocol.js";

const hello = (over = {}) =>
  JSON.stringify({ t: "hello", protocol: PROTOCOL, placeId: "123", gameId: "456", pluginVersion: "0.1.0", ...over });

// ---------------------------------------------------------------- framing

test("rejects anything that is not a JSON object frame", () => {
  for (const bad of ["", "not json", "[]", "null", '"a string"', "42"]) {
    assert.throws(() => decodeFrame(bad), ProtocolError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.throws(() => decodeFrame(Buffer.from("{}")), /frame must be text/);
});

test("rejects unknown frame types rather than passing them through", () => {
  assert.throws(() => decodeFrame(JSON.stringify({ t: "req", id: 1, op: "get" })), /unknown frame type/);
  assert.throws(() => decodeFrame(JSON.stringify({ t: "nonsense" })), /unknown frame type/);
  assert.throws(() => decodeFrame(JSON.stringify({})), /unknown frame type/);
});

test("rejects an oversized frame before parsing it", () => {
  // The guard has to come before JSON.parse, or a huge frame is already in
  // memory by the time it is refused.
  const huge = `{"t":"event","kind":"log","payload":"${"x".repeat(MAX_FRAME_BYTES)}"}`;
  assert.throws(() => decodeFrame(huge), /exceeds the size limit/);
});

// ----------------------------------------------------------------- hello

test("accepts a well-formed hello", () => {
  assert.deepEqual(decodeFrame(hello()), {
    t: "hello",
    protocol: PROTOCOL,
    placeId: "123",
    gameId: "456",
    pluginVersion: "0.1.0",
    placeName: null,
  });
});

test("rejects a mismatched protocol version", () => {
  assert.throws(() => decodeFrame(hello({ protocol: 2 })), /unsupported protocol/);
  assert.throws(() => decodeFrame(hello({ protocol: "1" })), /unsupported protocol/);
  assert.throws(() => decodeFrame(hello({ protocol: undefined })), /unsupported protocol/);
});

test("place and game ids must be decimal strings", () => {
  // Roblox ids are Int64. As JSON numbers they silently lose precision above
  // 2^53, so a numeric id is a bug worth failing on rather than coercing.
  assert.throws(() => decodeFrame(hello({ placeId: 123 })), /placeId must be a decimal string/);
  assert.throws(() => decodeFrame(hello({ gameId: "" })), /gameId must be a decimal string/);
  assert.throws(() => decodeFrame(hello({ placeId: "12a" })), /placeId must be a decimal string/);
  assert.throws(() => decodeFrame(hello({ gameId: "-5" })), /gameId must be a decimal string/);

  // A real Int64 beyond Number.MAX_SAFE_INTEGER must survive intact.
  const big = "9007199254740993";
  assert.equal(decodeFrame(hello({ placeId: big })).placeId, big);
});

test("rejects an absent or oversized plugin version", () => {
  assert.throws(() => decodeFrame(hello({ pluginVersion: "" })), /pluginVersion/);
  assert.throws(() => decodeFrame(hello({ pluginVersion: "x".repeat(65) })), /exceeds 64 characters/);
});

test("placeName is optional and defaults to null", () => {
  // An older plugin will not send one, and a place opened from a local file
  // has no meaningful name. Neither is an error.
  assert.equal(decodeFrame(hello()).placeName, null);
  assert.equal(decodeFrame(hello({ placeName: null })).placeName, null);
  assert.equal(decodeFrame(hello({ placeName: "Race Stars" })).placeName, "Race Stars");
});

test("placeName is still validated when present", () => {
  assert.throws(() => decodeFrame(hello({ placeName: "" })), /placeName/);
  assert.throws(() => decodeFrame(hello({ placeName: 42 })), /placeName/);
  assert.throws(() => decodeFrame(hello({ placeName: "x".repeat(129) })), /exceeds 128 characters/);
});

// -------------------------------------------------------------- responses

test("accepts a successful response and defaults a missing value to null", () => {
  assert.deepEqual(decodeFrame(JSON.stringify({ t: "res", id: 7, ok: true, value: { a: 1 } })), {
    t: "res",
    id: 7,
    ok: true,
    value: { a: 1 },
  });
  assert.equal(decodeFrame(JSON.stringify({ t: "res", id: 0, ok: true })).value, null);
});

test("rejects malformed response ids and ok flags", () => {
  for (const id of [-1, 1.5, "1", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => decodeFrame(JSON.stringify({ t: "res", id, ok: true })), /response id/);
  }
  assert.throws(() => decodeFrame(JSON.stringify({ t: "res", id: 1, ok: "yes" })), /response ok/);
});

test("a failed response must carry an error object", () => {
  assert.throws(() => decodeFrame(JSON.stringify({ t: "res", id: 1, ok: false })), /must carry an error object/);
  assert.throws(
    () => decodeFrame(JSON.stringify({ t: "res", id: 1, ok: false, error: "boom" })),
    /must carry an error object/,
  );
});

test("an unrecognised error code is preserved, not relabelled", () => {
  // Callers branch on codes. Rewriting one the daemon does not know about
  // would hide what the plugin actually reported.
  const decoded = decodeFrame(
    JSON.stringify({ t: "res", id: 1, ok: false, error: { code: "SOMETHING_NEW", message: "hi" } }),
  );
  assert.equal(decoded.error.code, "SOMETHING_NEW");
  assert.equal(decoded.error.retryable, false);
});

test("a failed response without a usable code falls back to PLUGIN_ERROR", () => {
  const decoded = decodeFrame(JSON.stringify({ t: "res", id: 1, ok: false, error: { message: "x" } }));
  assert.equal(decoded.error.code, ERROR.PLUGIN_ERROR);
  assert.equal(decoded.error.message, "x");
});

test("retryable is strictly boolean true, never truthy", () => {
  const decoded = decodeFrame(
    JSON.stringify({ t: "res", id: 1, ok: false, error: { code: "TIMEOUT", message: "x", retryable: "yes" } }),
  );
  assert.equal(decoded.error.retryable, false);
});

// ----------------------------------------------------------------- events

test("accepts an event and defaults a missing payload", () => {
  assert.deepEqual(decodeFrame(JSON.stringify({ t: "event", kind: "log", payload: { line: "hi" } })), {
    t: "event",
    kind: "log",
    payload: { line: "hi" },
  });
  assert.equal(decodeFrame(JSON.stringify({ t: "event", kind: "log" })).payload, null);
});

test("rejects an event with no kind", () => {
  assert.throws(() => decodeFrame(JSON.stringify({ t: "event" })), /event kind/);
  assert.throws(() => decodeFrame(JSON.stringify({ t: "event", kind: "" })), /event kind/);
});

// --------------------------------------------------------------- requests

test("encodes a request round-trippable by JSON.parse", () => {
  assert.deepEqual(JSON.parse(encodeRequest(3, "get", { path: "Workspace/Part" })), {
    t: "req",
    id: 3,
    op: "get",
    args: { path: "Workspace/Part" },
  });
  assert.deepEqual(JSON.parse(encodeRequest(0, "ping")).args, {});
});

test("rejects malformed request ids, ops, and args", () => {
  assert.throws(() => encodeRequest(-1, "get"), /request id/);
  assert.throws(() => encodeRequest(1.5, "get"), /request id/);
  assert.throws(() => encodeRequest(1, ""), /op/);
  assert.throws(() => encodeRequest(1, "x".repeat(65)), /exceeds 64 characters/);
  assert.throws(() => encodeRequest(1, "get", []), /args must be an object/);
  assert.throws(() => encodeRequest(1, "get", null), /args must be an object/);
});

// ------------------------------------------------------------------ toError

test("toError normalizes protocol errors, plain errors, and thrown values", () => {
  assert.deepEqual(toError(new ProtocolError(ERROR.INVALID_ARGUMENT, "bad")), {
    code: ERROR.INVALID_ARGUMENT,
    message: "bad",
    retryable: false,
  });

  assert.equal(toError(new Error("plain")).code, ERROR.PLUGIN_ERROR);
  assert.equal(toError(new Error("plain")).message, "plain");
  assert.equal(toError("just a string").message, "just a string");
  assert.equal(toError(new Error("x"), ERROR.TIMEOUT).code, ERROR.TIMEOUT);
});

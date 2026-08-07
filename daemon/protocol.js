// The control protocol, and the only place its shape is defined.
//
// Everything here is a pure function over a decoded value, so the wire format
// can be tested without a socket. The daemon, the CLI, and the plugin handlers
// all validate through this module rather than reimplementing the checks.
//
// Frames are JSON text in both directions:
//   plugin -> daemon   {"t":"hello", protocol, placeId, gameId, pluginVersion}
//   daemon -> plugin   {"t":"req",   id, op, args}
//   plugin -> daemon   {"t":"res",   id, ok, value|error}
//   plugin -> daemon   {"t":"event", kind, ...}

export const PROTOCOL = 1;
export const DEFAULT_PORT = 7900;

// Bounded so a runaway plugin cannot exhaust daemon memory with one frame.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const ERROR = {
  UNKNOWN_OP: "UNKNOWN_OP",
  NOT_FOUND: "NOT_FOUND",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  CONFLICT: "CONFLICT",
  TIMEOUT: "TIMEOUT",
  PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
  PLUGIN_ERROR: "PLUGIN_ERROR",
  NOT_CONNECTED: "NOT_CONNECTED",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
};

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

const fail = (message) => {
  throw new ProtocolError(ERROR.PROTOCOL_ERROR, message);
};

/** Roblox IDs are Int64 and lose precision as JSON numbers, so they stay strings. */
function requireIdString(value, field) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    fail(`${field} must be a decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireString(value, field, { max = 256 } = {}) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  return value;
}

/**
 * Decodes one raw frame. Rejects anything it does not fully understand rather
 * than passing a partially-valid object downstream — a malformed frame is a
 * bug or an intrusion, and neither should reach an op handler.
 */
export function decodeFrame(raw) {
  if (typeof raw !== "string") fail("frame must be text");
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) fail("frame exceeds the size limit");

  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    fail("frame is not valid JSON");
  }

  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) fail("frame must be an object");

  switch (frame.t) {
    case "hello":
      return decodeHello(frame);
    case "res":
      return decodeResponse(frame);
    case "event":
      return decodeEvent(frame);
    default:
      fail(`unknown frame type: ${JSON.stringify(frame.t)}`);
  }
}

function decodeHello(frame) {
  if (frame.protocol !== PROTOCOL) {
    fail(`unsupported protocol ${JSON.stringify(frame.protocol)}, expected ${PROTOCOL}`);
  }

  return {
    t: "hello",
    protocol: PROTOCOL,
    placeId: requireIdString(frame.placeId, "placeId"),
    gameId: requireIdString(frame.gameId, "gameId"),
    pluginVersion: requireString(frame.pluginVersion, "pluginVersion", { max: 64 }),
    // Optional: a place opened from a local file has no useful name, and an
    // older plugin will not send one at all. Callers must handle null.
    placeName:
      frame.placeName === undefined || frame.placeName === null
        ? null
        : requireString(frame.placeName, "placeName", { max: 128 }),
    // Persistent across restarts, which placeId is not for an unpublished
    // place: every one of those reports 0, so the id alone cannot tell two of
    // them apart. Optional — an older plugin will not send it, and a place with
    // no marker yet has none to send.
    argonId:
      frame.argonId === undefined || frame.argonId === null
        ? null
        : requireString(frame.argonId, "argonId", { max: 64 }),
  };
}

function decodeResponse(frame) {
  if (!Number.isSafeInteger(frame.id) || frame.id < 0) fail("response id must be a non-negative integer");
  if (typeof frame.ok !== "boolean") fail("response ok must be a boolean");

  if (frame.ok) return { t: "res", id: frame.id, ok: true, value: frame.value ?? null };

  const error = frame.error;
  if (error === null || typeof error !== "object") fail("failed response must carry an error object");

  return {
    t: "res",
    id: frame.id,
    ok: false,
    error: {
      // An unrecognised code is preserved rather than rewritten: callers branch
      // on codes, and silently relabelling one hides what actually happened.
      code: typeof error.code === "string" && error.code ? error.code : ERROR.PLUGIN_ERROR,
      message: typeof error.message === "string" ? error.message : "the plugin reported an error",
      retryable: error.retryable === true,
    },
  };
}

function decodeEvent(frame) {
  return {
    t: "event",
    kind: requireString(frame.kind, "event kind", { max: 64 }),
    payload: frame.payload ?? null,
  };
}

/** Builds an outbound request. Ids are assigned by the caller's sequence. */
export function encodeRequest(id, op, args = {}) {
  if (!Number.isSafeInteger(id) || id < 0) fail("request id must be a non-negative integer");
  requireString(op, "op", { max: 64 });
  if (args === null || typeof args !== "object" || Array.isArray(args)) fail("args must be an object");

  return JSON.stringify({ t: "req", id, op, args });
}

/** Normalizes any thrown value into the error shape callers can branch on. */
export function toError(cause, fallbackCode = ERROR.PLUGIN_ERROR) {
  if (cause instanceof ProtocolError) {
    return { code: cause.code, message: cause.message, retryable: false };
  }
  if (cause instanceof Error) {
    return { code: cause.code ?? fallbackCode, message: cause.message, retryable: false };
  }
  return { code: fallbackCode, message: String(cause), retryable: false };
}

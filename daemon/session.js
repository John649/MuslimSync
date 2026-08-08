// One connected Studio plugin.
//
// Owns request/response correlation and the failure modes that come with it:
// a response that never arrives, a response to a request that already timed
// out, and a socket that drops with requests still in flight. `send` is
// injected so all of that is testable without a real socket.

import { encodeRequest, ERROR } from "./protocol.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

export class Session {
  #send;
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #listeners = new Set();

  constructor({ send, hello, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.#send = send;
    this.hello = hello;
    this.timeoutMs = timeoutMs;
    this.connectedAt = Date.now();
  }

  /**
   * The shortest stable handle for this place.
   *
   * A published place has a real placeId. An unpublished one reports 0, so its
   * argonId marker is used instead — it lives in the place and survives
   * restarts. With neither, the connection key is all there is, and that only
   * lasts as long as the connection.
   */
  get ref() {
    if (this.placeId && this.placeId !== "0") return this.placeId;
    if (this.hello.argonId) return this.hello.argonId.slice(0, 8);
    return this.key;
  }

  /** The place's title, for labelling. Never for selecting — see Daemon#session. */
  get placeName() {
    return this.hello.placeName ?? null;
  }

  get placeId() {
    return this.hello.placeId;
  }

  get gameId() {
    return this.hello.gameId;
  }

  get closed() {
    return this.#closed;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /** Sends one op and resolves with its value, or rejects with an error object. */
  request(op, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.#closed) {
      return Promise.reject(named(ERROR.NOT_CONNECTED, "the Studio plugin is not connected"));
    }

    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the entry first: a late response must find nothing to settle
        // rather than resolving an already-rejected promise.
        this.#pending.delete(id);
        reject(named(ERROR.TIMEOUT, `${op} timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);

      // Never hold the process open waiting on a plugin reply.
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer, op });

      try {
        this.#send(encodeRequest(id, op, args));
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }

  /** Routes one decoded inbound frame. Unknown ids are ignored, not fatal. */
  handleFrame(frame) {
    if (frame.t === "event") {
      for (const listener of this.#listeners) listener(frame);
      return;
    }

    if (frame.t !== "res") return;

    const entry = this.#pending.get(frame.id);

    // A response to a request that already timed out, or a duplicate. Dropping
    // it is correct — its promise is long settled.
    if (!entry) return;

    this.#pending.delete(frame.id);
    clearTimeout(entry.timer);

    if (frame.ok) entry.resolve(frame.value);
    else entry.reject(named(frame.error.code, frame.error.message, frame.error.retryable));
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fails every in-flight request. Callers must never be left hanging. */
  close(reason = "the Studio plugin disconnected") {
    if (this.#closed) return;
    this.#closed = true;

    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(named(ERROR.NOT_CONNECTED, reason, true));
    }

    this.#pending.clear();
    this.#listeners.clear();
  }
}

function named(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

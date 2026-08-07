import { test } from "node:test";
import assert from "node:assert/strict";

import { explainUnreachable } from "./reach.js";

/** Node puts the syscall error on `cause`, which is what a real fetch throws. */
const failing = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("a refused connection says the app may not be running", () => {
  assert.match(explainUnreachable(failing("ECONNREFUSED"), 7900), /no daemon on port 7900/);
});

test("a denied connection blames the sandbox, not the app", () => {
  // This is the one that cost twenty minutes: a sandboxed shell reported the
  // daemon as stopped while it was serving two Studio places, and the advice
  // was to restart an app that was never down.
  for (const code of ["EPERM", "EACCES"]) {
    const message = explainUnreachable(failing(code), 7900);

    assert.match(message, /sandbox or firewall/);
    assert.match(message, /not the daemon/);
    assert.doesNotMatch(message, /Is the app running/);
  }
});

test("unreachable loopback is named as such", () => {
  assert.match(explainUnreachable(failing("EHOSTUNREACH"), 7900), /loopback networking looks broken/);
});

test("a timeout is not reported as a refusal", () => {
  // Something accepted the packets and never replied, which a firewall does and
  // a closed port does not — different cause, different fix.
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });

  assert.match(explainUnreachable(timeout, 7900), /never answered/);
});

test("an unrecognised failure still names the port and the code", () => {
  const message = explainUnreachable(failing("EMFILE"), 7900);

  assert.match(message, /7900/);
  assert.match(message, /EMFILE/);
});

test("an error with nothing on it does not print undefined", () => {
  assert.doesNotMatch(explainUnreachable(new Error("boom"), 7900), /undefined|null/);
});

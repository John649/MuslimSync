// `msync test` — run a Luau file inside a real playtest and report a verdict.
//
// The whole point of the playtest agent is that a script gets to run where the
// game actually runs: with a live DataModel, a spawned player, and replication
// between server and client. Everything here exists to get a file into that
// environment and get an honest pass/fail back out.
//
// The verdict convention is Lua's own: a script that returns without throwing
// passes, and `error(...)` or `assert(...)` fails. There is no bespoke
// `playtest.pass()` API to learn, because `assert` already is one.

const READY_TIMEOUT_MS = 45000;
const POLL_MS = 500;

export class TestFailure extends Error {
  constructor(message, { context, stopped } = {}) {
    super(message);
    this.context = context;
    this.stopped = stopped;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a named context to join the bridge.
 *
 * A playtest takes a few seconds to boot and the client context arrives after
 * the server, so starting one and immediately executing would fail on timing
 * alone rather than on anything the script did.
 */
async function waitForContext(op, context, { timeoutMs = READY_TIMEOUT_MS, log } = {}) {
  timeoutMs = timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    const status = await op("playtest_status", {});

    // Contexts arrive as {name, kind}, not as bare strings — checked against
    // the live op, because a fake is only worth as much as its fidelity.
    if (status.contexts?.some((candidate) => (candidate?.name ?? candidate) === context)) return status;

    if (!announced) {
      log?.(`waiting for the ${context} context`);
      announced = true;
    }

    await sleep(POLL_MS);
  }

  throw new TestFailure(`the ${context} context never connected within ${Math.round(timeoutMs / 1000)}s`, { context });
}

/**
 * Starts a playtest, runs `source` in it, and stops it again.
 *
 * The stop runs whatever happened, because a failed test that leaves Studio
 * stuck in play mode costs more than the test saved.
 */
export async function runTest(op, { source, context = "server", mode = "play", players, readyTimeoutMs, log = () => {} }) {
  const args = { mode };
  if (players !== undefined) args.players = players;

  log(`starting a ${mode} playtest`);
  await op("playtest_start", args);

  let result;
  let failure = null;

  try {
    await waitForContext(op, context, { log, timeoutMs: readyTimeoutMs });
    log(`running in ${context}`);

    result = await op("playtest_exec", { context, source });

    if (result.ok === false) {
      failure = new TestFailure(String(result.error), { context });
    }
  } catch (cause) {
    failure = cause instanceof TestFailure ? cause : new TestFailure(cause.message, { context });
  } finally {
    // Reported rather than thrown: a stop that fails must not mask the real
    // verdict, which is what the caller actually asked for.
    try {
      await op("playtest_stop", {});
      log("playtest stopped");
    } catch (cause) {
      log(`could not stop the playtest: ${cause.message}`);
    }
  }

  if (failure) throw failure;

  return { context, value: decodeValue(result) };
}

/**
 * Reads what the script returned.
 *
 * The plugin JSON-encodes table results and says so with a flag, so a check
 * that returns `{ player = "x", health = 100 }` arrives as that object rather
 * than as "table: 0x033c3ab2bf110f56". A flag that lies is treated as a plain
 * string — the value is still worth showing.
 */
export function decodeValue(result) {
  if (!result || result.value === undefined || result.value === null) return null;
  if (!result.json) return result.value;

  try {
    return JSON.parse(result.value);
  } catch {
    return result.value;
  }
}

/** Renders a verdict the way a test runner should: short, and unambiguous. */
export function formatVerdict({ context, value }) {
  const lines = [`PASS  ${context}`];

  if (value !== null && value !== undefined) {
    lines.push(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
  }

  return lines.join("\n");
}

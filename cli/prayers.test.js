import { test } from "node:test";
import assert from "node:assert/strict";

import { prayers, parseLocation } from "./prayers.js";

/** An in-memory stand-in for app/settings.js. */
function fakeSettings(initial = {}) {
  let stored = { prayer: initial };
  return {
    read: () => stored,
    update: (patch) => {
      stored = { ...stored, ...patch };
      return stored;
    },
    stored: () => stored,
  };
}

const MECCA = { latitude: 21.4225, longitude: 39.8262 };

test("parseLocation reads coordinates and refuses junk", () => {
  assert.deepEqual(parseLocation("21.42, 39.83"), { latitude: 21.42, longitude: 39.83 });
  assert.throws(() => parseLocation("mecca"), /latitude,longitude/);
  assert.throws(() => parseLocation("1,2,3"), /latitude,longitude/);
});

test("a stored location computes a full day without touching the network", async () => {
  const settings = fakeSettings({ enabled: true, location: MECCA, method: "mwl", asr: "standard" });

  const result = await prayers({ flags: { date: "2026-08-09" }, settings });

  // All six present, ISO-stamped, in order.
  const names = Object.keys(result.json.times);
  assert.deepEqual(names, ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"]);
  const stamps = Object.values(result.json.times).map((iso) => Date.parse(iso));
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] > stamps[i - 1]);

  assert.match(result.text, /Fajr/);
});

test("flags update the stored settings, and bad values are refused", async () => {
  const settings = fakeSettings({ enabled: true, location: MECCA, method: "mwl", asr: "standard" });

  await prayers({ flags: { date: "2026-08-09", method: "makkah", asr: "hanafi" }, settings });

  assert.equal(settings.stored().prayer.method, "makkah");
  assert.equal(settings.stored().prayer.asr, "hanafi");

  await assert.rejects(() => prayers({ flags: { method: "vibes" }, settings }), /unknown method/);
  await assert.rejects(() => prayers({ flags: { asr: "other" }, settings }), /standard or hanafi/);
  await assert.rejects(() => prayers({ flags: { date: "someday" }, settings }), /YYYY-MM-DD/);
});

test("--no-reminders flips the app's notification switch", async () => {
  const settings = fakeSettings({ enabled: true, location: MECCA, method: "mwl", asr: "standard" });

  // args.js parses --no-reminders into { reminders: false }.
  await prayers({ flags: { date: "2026-08-09", reminders: false }, settings });

  assert.equal(settings.stored().prayer.enabled, false);
});

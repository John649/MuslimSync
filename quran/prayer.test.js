import { test } from "node:test";
import assert from "node:assert/strict";

import { prayerTimes, nextPrayer, PRAYERS, METHODS } from "./prayer.js";

// Reference times fetched from aladhan.com (fixed here as fixtures — tests
// must not touch the network). Published sources disagree with each other by a
// minute or two from rounding conventions, so the tolerance is three minutes.
const TOLERANCE_MS = 3 * 60000;

const NYC = { latitude: 40.7128, longitude: -74.006 };
const MECCA = { latitude: 21.4225, longitude: 39.8262 };

/** aladhan reports local wall clock; these are those times converted to UTC. */
function utc(day, hhmm, offsetHours) {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 7, day, h - offsetHours, m);
}

function assertClose(actual, expectedMs, label) {
  assert.ok(actual instanceof Date, `${label} was not computed`);
  const drift = Math.abs(actual.getTime() - expectedMs);
  assert.ok(drift <= TOLERANCE_MS, `${label} off by ${(drift / 60000).toFixed(1)} min`);
}

test("matches aladhan for New York (ISNA, 2026-08-09)", () => {
  const times = prayerTimes({ year: 2026, month: 8, day: 9 }, NYC, { method: "isna" });

  // EDT is UTC-4.
  assertClose(times.fajr, utc(9, "04:35", -4), "fajr");
  assertClose(times.sunrise, utc(9, "06:01", -4), "sunrise");
  assertClose(times.dhuhr, utc(9, "13:02", -4), "dhuhr");
  assertClose(times.asr, utc(9, "16:54", -4), "asr");
  assertClose(times.maghrib, utc(9, "20:02", -4), "maghrib");
  assertClose(times.isha, utc(9, "21:28", -4), "isha");
});

test("matches aladhan for Mecca (MWL, 2026-08-09)", () => {
  const times = prayerTimes({ year: 2026, month: 8, day: 9 }, MECCA, { method: "mwl" });

  // AST is UTC+3.
  assertClose(times.fajr, utc(9, "04:38", 3), "fajr");
  assertClose(times.sunrise, utc(9, "05:57", 3), "sunrise");
  assertClose(times.dhuhr, utc(9, "12:26", 3), "dhuhr");
  assertClose(times.asr, utc(9, "15:47", 3), "asr");
  assertClose(times.maghrib, utc(9, "18:55", 3), "maghrib");
  assertClose(times.isha, utc(9, "20:10", 3), "isha");
});

test("the day is ordered the way a day is ordered", () => {
  const times = prayerTimes({ year: 2026, month: 3, day: 15 }, NYC, {});

  for (let i = 1; i < PRAYERS.length; i += 1) {
    const before = times[PRAYERS[i - 1]];
    const after = times[PRAYERS[i]];
    assert.ok(before.getTime() < after.getTime(), `${PRAYERS[i - 1]} must precede ${PRAYERS[i]}`);
  }
});

test("hanafi asr is later than standard asr", () => {
  const date = { year: 2026, month: 8, day: 9 };
  const standard = prayerTimes(date, NYC, {}).asr;
  const hanafi = prayerTimes(date, NYC, { asr: "hanafi" }).asr;

  assert.ok(hanafi.getTime() > standard.getTime());
});

test("makkah method fixes isha at 90 minutes after maghrib", () => {
  const times = prayerTimes({ year: 2026, month: 8, day: 9 }, MECCA, { method: "makkah" });

  assert.equal(times.isha.getTime() - times.maghrib.getTime(), 90 * 60000);
});

test("polar summer yields null rather than an invented time", () => {
  // Longyearbyen in June: the sun does not reach 18 degrees below the horizon,
  // and does not set at all.
  const times = prayerTimes({ year: 2026, month: 6, day: 21 }, { latitude: 78.22, longitude: 15.65 }, {});

  assert.equal(times.fajr, null);
  assert.equal(times.maghrib, null);
  // Solar noon still exists.
  assert.ok(times.dhuhr instanceof Date);
});

test("an unknown method or junk coordinates are refused loudly", () => {
  const date = { year: 2026, month: 8, day: 9 };

  assert.throws(() => prayerTimes(date, NYC, { method: "vibes" }), /unknown method/);
  assert.throws(() => prayerTimes(date, { latitude: 91, longitude: 0 }), /latitude/);
  assert.throws(() => prayerTimes(date, { latitude: 0, longitude: 999 }), /longitude/);
});

test("nextPrayer rolls into tomorrow after isha", () => {
  const times = prayerTimes({ year: 2026, month: 8, day: 9 }, MECCA, {});
  const afterIsha = new Date(times.isha.getTime() + 60000);

  const next = nextPrayer(afterIsha, MECCA, {});

  assert.equal(next.name, "fajr");
  assert.ok(next.time.getTime() > afterIsha.getTime());
  // Tomorrow's fajr, not a stale copy of today's.
  assert.ok(next.time.getTime() > times.fajr.getTime() + 20 * 3600000);
});

test("nextPrayer can leave sunrise out", () => {
  const times = prayerTimes({ year: 2026, month: 8, day: 9 }, MECCA, {});
  const afterFajr = new Date(times.fajr.getTime() + 60000);

  assert.equal(nextPrayer(afterFajr, MECCA, {}).name, "sunrise");
  assert.equal(nextPrayer(afterFajr, MECCA, { includeSunrise: false }).name, "dhuhr");
});

test("every documented method computes a full day", () => {
  for (const method of Object.keys(METHODS)) {
    const times = prayerTimes({ year: 2026, month: 8, day: 9 }, MECCA, { method });
    for (const prayer of PRAYERS) {
      assert.ok(times[prayer] instanceof Date, `${method} failed to compute ${prayer}`);
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTime, triggerOn, shouldFire, msUntilNextCheck, DEFAULT_TIME } from "./reminder.js";
import { dayNumber } from "../quran/daily.js";

const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min, 0, 0);
const NINE = { hour: 9, minute: 0 };

test("parseTime accepts the full valid range", () => {
  assert.deepEqual(parseTime({ hour: 0, minute: 0 }), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime({ hour: 23, minute: 59 }), { hour: 23, minute: 59 });
  assert.deepEqual(parseTime(DEFAULT_TIME), { hour: 9, minute: 0 });
});

test("parseTime rejects out-of-range and non-integer values instead of clamping", () => {
  // Clamping would silently move a user's reminder to a time they never chose.
  for (const bad of [{ hour: 24, minute: 0 }, { hour: -1, minute: 0 }, { hour: 9.5, minute: 0 }, { hour: "nine", minute: 0 }]) {
    assert.throws(() => parseTime(bad), /reminder hour/);
  }
  for (const bad of [{ hour: 9, minute: 60 }, { hour: 9, minute: -1 }, { hour: 9, minute: 1.5 }]) {
    assert.throws(() => parseTime(bad), /reminder minute/);
  }
  assert.throws(() => parseTime(undefined), /reminder hour/);
});

test("triggerOn lands on the same local day at the configured time", () => {
  const trigger = triggerOn(at(2026, 7, 6, 22, 30), { hour: 9, minute: 15 });
  assert.equal(trigger.getFullYear(), 2026);
  assert.equal(trigger.getMonth(), 7);
  assert.equal(trigger.getDate(), 6);
  assert.equal(trigger.getHours(), 9);
  assert.equal(trigger.getMinutes(), 15);
});

test("does not fire before the trigger time", () => {
  assert.equal(shouldFire(at(2026, 7, 6, 8, 59), NINE, null), false);
});

test("fires at the trigger time and after it", () => {
  assert.equal(shouldFire(at(2026, 7, 6, 9, 0), NINE, null), true);
  assert.equal(shouldFire(at(2026, 7, 6, 9, 1), NINE, null), true);
});

test("fires on wake when the trigger passed while the machine was asleep", () => {
  // The whole reason shouldFire takes `now` rather than trusting a timer.
  const wokeAtNoon = at(2026, 7, 6, 12, 0);
  assert.equal(shouldFire(wokeAtNoon, NINE, dayNumber(at(2026, 7, 5, 9, 0))), true);
});

test("fires at most once per day", () => {
  const today = dayNumber(at(2026, 7, 6, 9, 0));
  assert.equal(shouldFire(at(2026, 7, 6, 9, 0), NINE, today), false);
  assert.equal(shouldFire(at(2026, 7, 6, 23, 59), NINE, today), false);
});

test("fires again the next day after firing today", () => {
  const today = dayNumber(at(2026, 7, 6, 9, 0));
  assert.equal(shouldFire(at(2026, 7, 7, 9, 0), NINE, today), true);
});

test("moving the time later in the day re-arms rather than firing immediately", () => {
  const today = dayNumber(at(2026, 7, 6, 8, 0));
  assert.equal(shouldFire(at(2026, 7, 6, 8, 0), { hour: 18, minute: 0 }, today - 1), false);
});

test("next check waits for today's trigger when it is still ahead", () => {
  const now = at(2026, 7, 6, 8, 0);
  assert.equal(msUntilNextCheck(now, NINE, null), 60 * 60 * 1000);
});

test("next check waits for tomorrow's trigger once today has fired", () => {
  const now = at(2026, 7, 6, 9, 0);
  const ms = msUntilNextCheck(now, NINE, dayNumber(now));
  assert.equal(ms, 24 * 60 * 60 * 1000);
});

test("next check retries promptly when a reminder is overdue and unfired", () => {
  const ms = msUntilNextCheck(at(2026, 7, 6, 12, 0), NINE, null);
  assert.ok(ms > 0 && ms <= 1000, `expected a short retry, got ${ms}`);
});

test("next check is never zero or negative", () => {
  // A timer armed with <= 0 fires immediately and spins the event loop.
  for (let hour = 0; hour < 24; hour += 1) {
    for (const lastFired of [null, dayNumber(at(2026, 7, 6, hour)), dayNumber(at(2026, 7, 5, hour))]) {
      const ms = msUntilNextCheck(at(2026, 7, 6, hour, 30), NINE, lastFired);
      assert.ok(ms > 0, `hour ${hour} lastFired ${lastFired} gave ${ms}`);
    }
  }
});

test("tomorrow's trigger is built from calendar fields, not now + 24h", () => {
  // Across a DST boundary the wall-clock delta is 23 or 25 hours, but the
  // reminder must still arrive at the configured local time.
  const now = at(2026, 2, 7, 9, 0);
  const ms = msUntilNextCheck(now, NINE, dayNumber(now));
  const next = new Date(now.getTime() + ms);

  assert.equal(next.getHours(), 9, "reminder drifted off the configured hour");
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 8);
});

test("a month boundary rolls to the first of the next month", () => {
  const now = at(2026, 7, 31, 9, 0);
  const next = new Date(now.getTime() + msUntilNextCheck(now, NINE, dayNumber(now)));

  assert.equal(next.getMonth(), 8);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 9);
});

test("a year boundary rolls into January", () => {
  const now = at(2026, 11, 31, 9, 0);
  const next = new Date(now.getTime() + msUntilNextCheck(now, NINE, dayNumber(now)));

  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
});

test("midnight is a valid reminder time", () => {
  const midnight = { hour: 0, minute: 0 };
  assert.equal(shouldFire(at(2026, 7, 6, 0, 0), midnight, null), true);
  assert.equal(msUntilNextCheck(at(2026, 7, 6, 0, 0), midnight, dayNumber(at(2026, 7, 6, 0, 0))), 24 * 60 * 60 * 1000);
});

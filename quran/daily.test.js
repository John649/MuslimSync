import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRef,
  resolve,
  dayNumber,
  cycleOrder,
  orderForCycle,
  indexForDay,
  verseOfTheDay,
  poolRefs,
  loadQuran,
} from "./daily.js";

const data = loadQuran();
const POOL_SIZE = poolRefs().length;

// ---------------------------------------------------------------- dataset

test("dataset has the canonical surah and ayah counts", () => {
  assert.equal(data.quran.surahs.length, 114);
  assert.equal(data.quran.verses.length, 6236);
  assert.equal(data.quran.meta.verseCount, 6236);
});

test("every surah's declared ayah count matches the verses actually present", () => {
  const counted = new Map();
  for (const v of data.quran.verses) {
    counted.set(v.s, (counted.get(v.s) ?? 0) + 1);
  }

  for (const surah of data.quran.surahs) {
    assert.equal(counted.get(surah.n), surah.ayahs, `surah ${surah.n} (${surah.name})`);
  }
});

test("ayah numbers run 1..n contiguously within every surah", () => {
  const seen = new Map();
  for (const v of data.quran.verses) {
    if (!seen.has(v.s)) seen.set(v.s, []);
    seen.get(v.s).push(v.a);
  }

  for (const [surah, ayahs] of seen) {
    ayahs.sort((a, b) => a - b);
    for (let i = 0; i < ayahs.length; i += 1) {
      assert.equal(ayahs[i], i + 1, `surah ${surah} has a gap or duplicate at position ${i + 1}`);
    }
  }
});

test("no verse has empty Arabic or an empty translation", () => {
  const translations = Object.keys(data.quran.meta.translations);
  assert.ok(translations.length >= 2, "expected at least two bundled translations");

  for (const v of data.quran.verses) {
    assert.ok(v.ar && v.ar.trim().length > 0, `${v.s}:${v.a} has no Arabic`);
    for (const name of translations) {
      assert.ok(v.t[name] && v.t[name].trim().length > 0, `${v.s}:${v.a} has no ${name} translation`);
    }
  }
});

test("Arabic text is actually Arabic script", () => {
  // Guards against a build that silently wrote a transliteration edition into
  // the Arabic slot — the text would still be non-empty and pass every other
  // check while rendering as Latin characters in the card.
  const arabic = /[؀-ۿ]/;
  for (const v of data.quran.verses) {
    assert.ok(arabic.test(v.ar), `${v.s}:${v.a} contains no Arabic-range characters`);
  }
});

// ------------------------------------------------------------- references

test("parseRef reads single verses and ranges", () => {
  assert.deepEqual(parseRef("2:255"), { surah: 2, from: 255, to: 255 });
  assert.deepEqual(parseRef("94:5-6"), { surah: 94, from: 5, to: 6 });
  assert.deepEqual(parseRef("  103:1-3  "), { surah: 103, from: 1, to: 3 });
});

test("parseRef rejects malformed and reversed references", () => {
  for (const bad of ["", "2", "2:", ":255", "2-255", "2:255:1", "two:255", "2:255-", "-2:255"]) {
    assert.throws(() => parseRef(bad), /malformed verse reference/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.throws(() => parseRef("94:6-5"), /reversed verse range/);
});

test("resolve rejects references outside the dataset", () => {
  assert.throws(() => resolve("115:1"), /no such surah/);
  assert.throws(() => resolve("1:8"), /no such verse/); // Al-Fatiha has 7
  assert.throws(() => resolve("2:285-287"), /no such verse/); // Al-Baqara ends at 286
});

// -------------------------------------------------------------- the pool

test("every pool reference resolves to real, non-empty verses", () => {
  for (const ref of poolRefs()) {
    const result = resolve(ref);
    assert.ok(result.verses.length >= 1, `${ref} resolved to nothing`);
    assert.ok(result.surah.name, `${ref} has no surah name`);
    for (const verse of result.verses) {
      assert.ok(verse.arabic.trim(), `${ref} ayah ${verse.ayah} has no Arabic`);
      assert.ok(verse.translations.khattab.trim(), `${ref} ayah ${verse.ayah} has no translation`);
    }
  }
});

test("pool ranges are contiguous and ordered", () => {
  for (const ref of poolRefs()) {
    const { verses } = resolve(ref);
    for (let i = 1; i < verses.length; i += 1) {
      assert.equal(verses[i].ayah, verses[i - 1].ayah + 1, `${ref} is not contiguous`);
    }
  }
});

test("no verse appears in two pool entries", () => {
  const seen = new Map();
  for (const ref of poolRefs()) {
    const { surah, from, to } = parseRef(ref);
    for (let a = from; a <= to; a += 1) {
      const key = `${surah}:${a}`;
      assert.equal(seen.get(key), undefined, `${key} appears in both ${seen.get(key)} and ${ref}`);
      seen.set(key, ref);
    }
  }
});

// ------------------------------------------------------------ day numbers

test("dayNumber is stable across the whole local day", () => {
  const early = new Date(2026, 7, 6, 0, 0, 1);
  const late = new Date(2026, 7, 6, 23, 59, 59);
  assert.equal(dayNumber(early), dayNumber(late));
});

test("dayNumber advances by exactly one per calendar day", () => {
  assert.equal(dayNumber(new Date(2026, 7, 7)) - dayNumber(new Date(2026, 7, 6)), 1);
  // Month and year boundaries are where off-by-one bugs live.
  assert.equal(dayNumber(new Date(2026, 8, 1)) - dayNumber(new Date(2026, 7, 31)), 1);
  assert.equal(dayNumber(new Date(2027, 0, 1)) - dayNumber(new Date(2026, 11, 31)), 1);
  // 2028 is a leap year.
  assert.equal(dayNumber(new Date(2028, 1, 29)) - dayNumber(new Date(2028, 1, 28)), 1);
  assert.equal(dayNumber(new Date(2028, 2, 1)) - dayNumber(new Date(2028, 1, 29)), 1);
});

test("dayNumber survives a DST transition", () => {
  // In zones that observe it, one of these local days is 23 or 25 hours long.
  // Because dayNumber discards the time, the step must still be exactly 1.
  for (const [y, m, d] of [
    [2026, 2, 7],
    [2026, 2, 8],
    [2026, 10, 31],
    [2026, 9, 24],
  ]) {
    const step = dayNumber(new Date(y, m, d + 1, 12)) - dayNumber(new Date(y, m, d, 12));
    assert.equal(step, 1, `${y}-${m + 1}-${d + 1} did not advance by one day`);
  }
});

// -------------------------------------------------------------- selection

test("cycleOrder is a true permutation", () => {
  for (const cycle of [0, 1, 2, 41, 1000]) {
    const order = cycleOrder(POOL_SIZE, cycle);
    assert.equal(order.length, POOL_SIZE);
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      Array.from({ length: POOL_SIZE }, (_, i) => i),
      `cycle ${cycle} is not a permutation`,
    );
  }
});

test("different cycles shuffle differently", () => {
  assert.notDeepEqual(cycleOrder(POOL_SIZE, 0), cycleOrder(POOL_SIZE, 1));
});

test("every pool entry is shown exactly once per cycle", () => {
  // Aligned to a cycle boundary: the guarantee is one full sweep of the pool
  // per cycle, so an arbitrary n-day window legitimately spans two shuffles.
  const cycleStart = Math.floor(dayNumber(new Date(2026, 0, 1)) / POOL_SIZE) * POOL_SIZE;

  for (const cycle of [0, 1, 2]) {
    const seen = new Set();
    for (let i = 0; i < POOL_SIZE; i += 1) {
      seen.add(indexForDay(cycleStart + cycle * POOL_SIZE + i, POOL_SIZE));
    }
    assert.equal(seen.size, POOL_SIZE, `a verse repeated within cycle ${cycle}`);
  }
});

test("the adjusted cycle order is still a permutation", () => {
  for (const cycle of [0, 1, 2, 41, 1000]) {
    const order = orderForCycle(POOL_SIZE, cycle);
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      Array.from({ length: POOL_SIZE }, (_, i) => i),
      `cycle ${cycle} stopped being a permutation after adjustment`,
    );
  }
});

test("no cycle opens on the entry the previous cycle closed with", () => {
  for (let cycle = 0; cycle < 200; cycle += 1) {
    const previous = orderForCycle(POOL_SIZE, cycle - 1);
    const current = orderForCycle(POOL_SIZE, cycle);
    assert.notEqual(current[0], previous[POOL_SIZE - 1], `cycle ${cycle} repeats across its boundary`);
  }
});

test("consecutive days never show the same verse", () => {
  const start = dayNumber(new Date(2026, 0, 1));
  // Span several cycles so the wrap from one cycle into the next is covered.
  for (let i = 0; i < POOL_SIZE * 3; i += 1) {
    assert.notEqual(
      indexForDay(start + i, POOL_SIZE),
      indexForDay(start + i + 1, POOL_SIZE),
      `day ${i} and ${i + 1} selected the same entry`,
    );
  }
});

test("selection is deterministic for a given date", () => {
  const date = new Date(2026, 7, 6, 9, 30);
  const later = new Date(2026, 7, 6, 22, 15);

  assert.equal(verseOfTheDay(date).ref, verseOfTheDay(date).ref);
  assert.equal(verseOfTheDay(date).ref, verseOfTheDay(later).ref, "reopening later the same day changed the verse");
});

test("selection works for dates before the epoch", () => {
  // Negative day numbers must floor-divide, not truncate toward zero, or the
  // position lands outside the shuffled order and yields undefined.
  const index = indexForDay(dayNumber(new Date(1969, 0, 1)), POOL_SIZE);
  assert.ok(Number.isInteger(index) && index >= 0 && index < POOL_SIZE, `got ${index}`);
});

test("indexForDay rejects an empty pool rather than returning undefined", () => {
  assert.throws(() => indexForDay(0, 0), /pool is empty/);
});

test("a full cycle of days all render a usable card", () => {
  const start = new Date(2026, 0, 1);

  for (let i = 0; i < POOL_SIZE; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const verse = verseOfTheDay(date);

    assert.ok(verse.surah.name, `${date.toDateString()} has no surah name`);
    assert.ok(verse.theme, `${verse.ref} has no theme`);
    assert.ok(verse.verses.length >= 1);
    assert.ok(verse.verses.every((v) => v.arabic.trim() && v.translations.khattab.trim()));
  }
});

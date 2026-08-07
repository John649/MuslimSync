// Deterministic daily verse selection.
//
// Two properties matter and neither is given by a naive `hash(date) % n`:
//
//   1. Reopening the app on the same day must show the same verse. Selection is
//      therefore a pure function of the local calendar date — never of the
//      clock, a counter, or Math.random.
//   2. A verse should not reappear until the whole pool has been seen. So each
//      cycle of `n` days is a seeded shuffle of the pool, and the day's
//      position indexes into it. Day n-1 and day n are always different verses,
//      and every entry appears exactly once per cycle.
//
// Local date, not UTC: a user in Auckland and a user in Vancouver should each
// get "today's" verse by their own reckoning.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let cache = null;

function load() {
  if (!cache) {
    const quran = JSON.parse(readFileSync(path.join(HERE, "quran.json"), "utf8"));
    cache = {
      quran,
      pool: JSON.parse(readFileSync(path.join(HERE, "daily-pool.json"), "utf8")).entries,
      verses: new Map(quran.verses.map((v) => [`${v.s}:${v.a}`, v])),
      surahs: new Map(quran.surahs.map((s) => [s.n, s])),
    };
  }
  return cache;
}

/** Parses "2:255" or "94:5-6" into {surah, from, to}. Throws on anything else. */
export function parseRef(ref) {
  const match = /^(\d+):(\d+)(?:-(\d+))?$/.exec(String(ref).trim());
  if (!match) throw new Error(`malformed verse reference: ${ref}`);

  const surah = Number(match[1]);
  const from = Number(match[2]);
  const to = match[3] === undefined ? from : Number(match[3]);

  if (to < from) throw new Error(`reversed verse range: ${ref}`);

  return { surah, from, to };
}

/** Resolves a ref to its surah metadata and ordered verses. */
export function resolve(ref, data = load()) {
  const { surah, from, to } = parseRef(ref);
  const meta = data.surahs.get(surah);
  if (!meta) throw new Error(`no such surah: ${surah}`);

  const verses = [];
  for (let a = from; a <= to; a += 1) {
    const verse = data.verses.get(`${surah}:${a}`);
    if (!verse) throw new Error(`no such verse: ${surah}:${a}`);
    verses.push({ ayah: a, arabic: verse.ar, translations: verse.t });
  }

  return { ref, surah: meta, verses };
}

/** Days since the Unix epoch for a *local* calendar date. */
export function dayNumber(date = new Date()) {
  // Date.UTC of the local Y/M/D deliberately discards the time and the zone,
  // so 23:59 and 00:01 on the same local day yield the same number, and a DST
  // shift cannot move a day forwards or backwards.
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over 0..n-1, seeded so a given cycle always shuffles the same way. */
export function cycleOrder(n, cycle) {
  const order = Array.from({ length: n }, (_, i) => i);
  const random = mulberry32(cycle * 2654435761);

  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  return order;
}

/**
 * A cycle's order, adjusted so it cannot open with the entry the previous cycle
 * closed on. Without this, "no repeat until the pool is exhausted" holds inside
 * a cycle but breaks at every boundary, which is exactly where a user would
 * notice it: the same verse two mornings running.
 *
 * Swapping the first two positions preserves the permutation and, for pools of
 * three or more, cannot disturb the last position — so the previous cycle's
 * closing entry is well defined without recursing.
 */
export function orderForCycle(n, cycle) {
  const order = cycleOrder(n, cycle);

  if (n >= 3 && order[0] === cycleOrder(n, cycle - 1)[n - 1]) {
    [order[0], order[1]] = [order[1], order[0]];
  }

  return order;
}

/** The pool index for a given day. Exported so tests can assert cycle behaviour. */
export function indexForDay(day, poolSize) {
  if (poolSize <= 0) throw new Error("the daily pool is empty");

  // Floor division, so dates before 1970 still land in a valid cycle.
  const cycle = Math.floor(day / poolSize);
  const position = day - cycle * poolSize;

  return orderForCycle(poolSize, cycle)[position];
}

/** Today's verse (or any given date's), with surah metadata and both translations. */
export function verseOfTheDay(date = new Date(), data = load()) {
  const entry = data.pool[indexForDay(dayNumber(date), data.pool.length)];
  return { ...resolve(entry.ref, data), theme: entry.theme };
}

/** Every ref in the pool, for validation and for the "draw another" control. */
export function poolRefs(data = load()) {
  return data.pool.map((entry) => entry.ref);
}

export { load as loadQuran };

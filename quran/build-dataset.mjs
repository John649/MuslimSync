// Regenerates quran/quran.json from public Tanzil-derived editions.
//
// Committed output, reproducible input: run `node quran/build-dataset.mjs` to
// rebuild. Nothing at runtime touches the network — the app must work offline.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1";

// Arabic is Uthmani Hafs with full diacritics — the script Muslims actually
// read, not a stripped simple-text variant.
const ARABIC = "ara-quranuthmanihaf";

// Khattab (The Clear Quran) is the default because it reads as modern English
// rather than 1930s register. Pickthall ships alongside it as an unambiguously
// public-domain fallback. See quran/README.md for the licensing note.
const TRANSLATIONS = {
  khattab: { id: "eng-mustafakhattaba", label: "Mustafa Khattab — The Clear Quran" },
  pickthall: { id: "eng-mohammedmarmadu", label: "Marmaduke Pickthall (public domain)" },
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

function key(chapter, verse) {
  return `${chapter}:${verse}`;
}

async function main() {
  const [info, arabic, ...translations] = await Promise.all([
    fetchJson(`${BASE}/info.json`),
    fetchJson(`${BASE}/editions/${ARABIC}.min.json`),
    ...Object.values(TRANSLATIONS).map((t) => fetchJson(`${BASE}/editions/${t.id}.min.json`)),
  ]);

  const names = Object.keys(TRANSLATIONS);
  const byName = new Map(
    names.map((name, i) => [name, new Map(translations[i].quran.map((v) => [key(v.chapter, v.verse), v.text]))]),
  );

  const surahs = info.chapters.map((c) => ({
    n: c.chapter,
    name: c.name,
    english: c.englishname,
    arabic: c.arabicname,
    revelation: c.revelation,
    ayahs: c.verses.length,
  }));

  const verses = arabic.quran.map((v) => {
    const t = {};
    for (const name of names) {
      const text = byName.get(name).get(key(v.chapter, v.verse));
      // A missing translation for a verse that exists in Arabic means the
      // editions disagree on verse numbering. Fail loudly rather than shipping
      // a card that renders an empty translation.
      if (!text) throw new Error(`${name} is missing ${key(v.chapter, v.verse)}`);
      t[name] = text;
    }
    return { s: v.chapter, a: v.verse, ar: v.text, t };
  });

  if (verses.length !== info.verses.count) {
    throw new Error(`expected ${info.verses.count} verses, built ${verses.length}`);
  }

  const out = {
    meta: {
      source: "https://github.com/fawazahmed0/quran-api (Tanzil-derived)",
      arabic: ARABIC,
      translations: Object.fromEntries(names.map((n) => [n, TRANSLATIONS[n].label])),
      verseCount: verses.length,
    },
    surahs,
    verses,
  };

  await writeFile(path.join(HERE, "quran.json"), JSON.stringify(out));
  console.log(`wrote quran.json — ${surahs.length} surahs, ${verses.length} verses`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

# Quran data

`quran.json` is generated — run `npm run build:quran` to rebuild it from source.
Nothing here touches the network at runtime; the app works offline.

## What's bundled

| Slot | Edition | Notes |
| --- | --- | --- |
| Arabic | Uthmani Hafs, with full diacritics | The script Muslims actually read, not a stripped simple-text variant |
| `khattab` | Mustafa Khattab, *The Clear Quran* | Default. Modern English that reads naturally on a card |
| `pickthall` | Marmaduke Pickthall | Public domain fallback |

Source: [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api), whose
texts derive from [Tanzil](https://tanzil.net).

## On the translation choice

The plan originally named Sahih International. It is not available in any freely
redistributable dataset — it is under copyright and the open APIs do not carry
it. Khattab's *The Clear Quran* is the closest match for what that choice was
reaching for (plain modern English, widely used, the default on Quran.com) and
is the one to keep unless there's a reason to change.

Khattab is under copyright, distributed freely for non-commercial use. Pickthall
ships alongside it and is unambiguously public domain, so a build that needs to
avoid any copyright question can default to `pickthall` by changing one setting.
**If MuslimSync is ever distributed commercially, confirm the Khattab terms or
switch the default.**

## The daily pool

`daily-pool.json` is a curated subset, not the whole Quran. A uniformly random
ayah out of 6,236 frequently lands mid-sentence in a legal or narrative passage
and reads poorly alone — the daily card wants verses that stand by themselves.

Ranges keep famous passages whole: `94:5` without `94:6` is half a thought, and
`112:1` without the rest of Al-Ikhlas is a fragment.

Every reference is verified against `quran.json` by `daily.test.js`, so a typo in
a surah or ayah number fails the build rather than shipping a wrong citation.

## Adding a verse

1. Add `{ "ref": "…", "theme": "…" }` to `daily-pool.json`.
2. Run `node --test quran/daily.test.js`.

The tests check that the ref resolves, that ranges are contiguous and in bounds,
and that no verse already appears in another entry.

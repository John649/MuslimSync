import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { universeName, suggestName, suggestFolder, forget } from "./universe.js";

beforeEach(forget);

/** A fetch that answers from a table and records what it was asked. */
function fakeFetch(reply) {
  const calls = [];

  const impl = async (url) => {
    calls.push(url);

    if (reply instanceof Error) throw reply;

    return {
      ok: reply.ok ?? true,
      json: async () => reply.body,
    };
  };

  return { impl, calls };
}

// ------------------------------------------------------------ universeName

test("returns the universe title", async () => {
  const { impl, calls } = fakeFetch({ body: { data: [{ name: "Tower Defence Simulator" }] } });

  assert.equal(await universeName("123", { fetchImpl: impl }), "Tower Defence Simulator");
  assert.match(calls[0], /universeIds=123/);
});

test("a private universe reads as no name, not as a name", async () => {
  // Roblox answers 200 with a placeholder rather than refusing, so taking the
  // body at face value would name every private project "[TITLE UNAVAILABLE]".
  const { impl } = fakeFetch({ body: { data: [{ name: "[TITLE UNAVAILABLE]" }] } });

  assert.equal(await universeName("123", { fetchImpl: impl }), null);
});

test("being offline is a null, not a throw", async () => {
  // The name fills in a form field. Nothing about it is worth failing over.
  const { impl } = fakeFetch(new Error("getaddrinfo ENOTFOUND"));

  assert.equal(await universeName("123", { fetchImpl: impl }), null);
});

test("a non-ok response is a null", async () => {
  const { impl } = fakeFetch({ ok: false, body: {} });
  assert.equal(await universeName("123", { fetchImpl: impl }), null);
});

test("an empty data array is a null", async () => {
  const { impl } = fakeFetch({ body: { data: [] } });
  assert.equal(await universeName("123", { fetchImpl: impl }), null);
});

test("an unpublished place is not asked about at all", async () => {
  // gameId 0 is every unpublished place, and asking would be a guaranteed miss
  // on every one of them.
  const { impl, calls } = fakeFetch({ body: { data: [{ name: "x" }] } });

  assert.equal(await universeName("0", { fetchImpl: impl }), null);
  assert.equal(await universeName("", { fetchImpl: impl }), null);
  assert.equal(await universeName("not-a-number", { fetchImpl: impl }), null);
  assert.equal(calls.length, 0);
});

test("answers are cached, including the negative ones", async () => {
  // A private universe stays private; re-asking per keystroke would be a
  // request per character.
  const { impl, calls } = fakeFetch({ body: { data: [{ name: "[TITLE UNAVAILABLE]" }] } });

  await universeName("55", { fetchImpl: impl });
  await universeName("55", { fetchImpl: impl });

  assert.equal(calls.length, 1);
});

test("a stale cache entry is refetched", async () => {
  const { impl, calls } = fakeFetch({ body: { data: [{ name: "Later" }] } });
  let clock = 0;

  await universeName("77", { fetchImpl: impl, now: () => clock });
  clock = 11 * 60 * 1000;
  await universeName("77", { fetchImpl: impl, now: () => clock });

  assert.equal(calls.length, 2);
});

// ------------------------------------------------------------- suggestName

test("both names read as Game - Place", () => {
  assert.equal(suggestName({ gameName: "Tower Defence", placeName: "Lobby" }), "Tower Defence - Lobby");
});

test("a place named after its game is not doubled", () => {
  // A single-place universe names its place after the game, and
  // "Tower Defence - Tower Defence" is nobody's project name.
  assert.equal(suggestName({ gameName: "Tower Defence", placeName: "Tower Defence" }), "Tower Defence");
  assert.equal(suggestName({ gameName: "Tower Defence", placeName: "tower defence" }), "tower defence");
});

test("a missing half falls back to the other", () => {
  assert.equal(suggestName({ gameName: null, placeName: "Lobby" }), "Lobby");
  assert.equal(suggestName({ gameName: "Tower Defence", placeName: "" }), "Tower Defence");
  assert.equal(suggestName({}), "");
});

// ----------------------------------------------------------- suggestFolder

test("spaces become dashes rather than vanishing", () => {
  // "GamePlace" would be the result of simply stripping them, and it reads as
  // one word that was never a word.
  assert.equal(suggestFolder("Tower Defence - Lobby"), "Tower-Defence-Lobby");
});

test("characters a filesystem would argue about are dropped", () => {
  assert.equal(suggestFolder("My Game: v2 / test?"), "My-Game-v2-test");
});

test("non-latin names survive", () => {
  // The slug is for a folder, not a URL, and mangling someone's language to
  // make an ascii path is not an improvement.
  assert.equal(suggestFolder("ゲーム - ロビー"), "ゲーム-ロビー");
  assert.equal(suggestFolder("مسجد الحرام"), "مسجد-الحرام");
});

test("a name with nothing usable still yields a folder", () => {
  // The dialog must have something to put in the field.
  assert.equal(suggestFolder("???"), "project");
  assert.equal(suggestFolder(""), "project");
  assert.equal(suggestFolder(null), "project");
});

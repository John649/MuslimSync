// Resolving a universe's name.
//
// Studio does not expose it. `game.Name` is the DataModel's name, which is
// "Place1" even for a published place; MarketplaceService:GetProductInfo names
// the *place*; and nothing on the DataModel, StudioService, or the product info
// table carries the universe title. All of that was checked against a live
// published place rather than assumed.
//
// So it is fetched here, where there is real network access. Roblox serves this
// anonymously for public universes and returns a placeholder for private ones,
// which is a "no" rather than an error — a private game simply has no name we
// are allowed to read, and the caller falls back to the place name.

const ENDPOINT = "https://games.roblox.com/v1/games";
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Roblox's stand-ins for "you may not see this".
const WITHHELD = new Set(["[ Content Deleted ]", "[TITLE UNAVAILABLE]", "[UNKNOWN]", ""]);

const cache = new Map();

/** Clears the memo. Exists for tests, which must not share state. */
export function forget() {
  cache.clear();
}

/**
 * The universe's title, or null when there isn't one we can read.
 *
 * Null covers every "no": private universe, bad id, no network, Roblox down.
 * The caller cannot act differently on those and a name it must not trust is
 * worse than no name, so they collapse into one answer.
 */
export async function universeName(gameId, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const id = String(gameId ?? "").trim();

  if (!/^\d+$/.test(id) || id === "0") return null;

  const hit = cache.get(id);
  if (hit && hit.at + CACHE_TTL_MS > now()) return hit.name;

  let name = null;

  try {
    const response = await fetchImpl(`${ENDPOINT}?universeIds=${id}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });

    if (response.ok) {
      const payload = await response.json();
      const candidate = payload?.data?.[0]?.name;

      if (typeof candidate === "string" && !WITHHELD.has(candidate.trim())) {
        name = candidate.trim();
      }
    }
  } catch {
    // Offline, timed out, or Roblox said something unexpected. The name is a
    // convenience on a form field; none of that is worth surfacing as an error.
    name = null;
  }

  // Negative answers are cached too. A private universe stays private, and
  // re-asking on every keystroke would be a request per character.
  cache.set(id, { name, at: now() });

  return name;
}

/**
 * The name to put in the field, given what each side knows.
 *
 * "Game - Place" when both are known and different; just the place otherwise.
 * They are collapsed when equal because a single-place universe names its place
 * after the game, and "Tower Defence - Tower Defence" is nobody's project name.
 */
export function suggestName({ gameName, placeName }) {
  const game = (gameName ?? "").trim();
  const place = (placeName ?? "").trim();

  if (!game) return place;
  if (!place) return game;
  if (game.toLowerCase() === place.toLowerCase()) return place;

  return `${game} - ${place}`;
}

/**
 * A folder name for a suggested project name.
 *
 * Spaces become dashes rather than vanishing, so "Game - Place" reads as
 * "Game-Place" and not "GamePlace". Anything a filesystem or a URL would argue
 * about is dropped.
 */
export function suggestFolder(name) {
  const cleaned = String(name ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || "project";
}

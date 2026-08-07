// Binary transport, off the WebSocket.
//
// A 4K PNG or an .rbxm buffer has no business being one giant JSON frame. The
// plugin leases an artifact, appends base64 chunks over plain HTTP, finalizes
// with a declared size and digest, and the CLI reads it back.
//
// Every limit here exists because the peer is a plugin that can be buggy or
// hostile: leases expire, chunks must append at the exact next offset, and the
// total byte budget is capped so a runaway upload cannot fill the disk.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_OPEN_LEASES = 8;
export const LEASE_TTL_MS = 120_000;
// A finalized artifact nobody consumes still has to go eventually.
export const FINALIZED_TTL_MS = 10 * 60_000;

export class ArtifactError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = () => randomBytes(16).toString("hex");

/** Constant-time compare, so a token cannot be guessed a byte at a time. */
function tokenMatches(expected, supplied) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Artifacts {
  #entries = new Map();

  constructor({ directory, now = () => Date.now() } = {}) {
    this.directory = directory;
    this.now = now;
    mkdirSync(directory, { recursive: true });
  }

  get size() {
    return this.#entries.size;
  }

  #file(artifactId) {
    return path.join(this.directory, `${artifactId}.bin`);
  }

  #entry(artifactId, token) {
    const entry = this.#entries.get(artifactId);
    if (!entry) throw new ArtifactError(404, "no such artifact");

    // Expiry is checked on access rather than by a timer, so a paused process
    // cannot leave a lease alive indefinitely.
    if (this.now() > entry.expiresAt) {
      this.#discard(artifactId);
      throw new ArtifactError(410, "artifact expired");
    }

    if (token !== undefined && !tokenMatches(entry.token, token)) {
      throw new ArtifactError(403, "invalid artifact token");
    }

    return entry;
  }

  #discard(artifactId) {
    this.#entries.delete(artifactId);
    try {
      rmSync(this.#file(artifactId), { force: true });
    } catch {
      // Best effort: a file we cannot remove must not break the caller.
    }
  }

  /** Drops anything past its deadline. Called before each new lease. */
  sweep() {
    for (const [artifactId, entry] of [...this.#entries]) {
      if (this.now() > entry.expiresAt) this.#discard(artifactId);
    }
  }

  lease({ size, mime = "application/octet-stream", sha256 } = {}) {
    this.sweep();

    const declared = Number(size);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new ArtifactError(400, "size must be a non-negative integer");
    if (declared > MAX_ARTIFACT_BYTES) throw new ArtifactError(413, `size exceeds ${MAX_ARTIFACT_BYTES} bytes`);

    const open = [...this.#entries.values()].filter((entry) => !entry.finalized).length;
    if (open >= MAX_OPEN_LEASES) throw new ArtifactError(429, "too many open artifact leases");

    const artifactId = id();
    const token = randomBytes(32).toString("hex");

    this.#entries.set(artifactId, {
      token,
      size: declared,
      mime: String(mime).slice(0, 128),
      sha256: sha256 ? String(sha256).toLowerCase() : null,
      offset: 0,
      finalized: false,
      expiresAt: this.now() + LEASE_TTL_MS,
    });

    writeFileSync(this.#file(artifactId), Buffer.alloc(0));

    return { id: artifactId, token, chunkBytes: MAX_CHUNK_BYTES };
  }

  /** Appends one chunk. `offset` must be exactly where the last one ended. */
  chunk(artifactId, token, { offset, dataBase64 }) {
    const entry = this.#entry(artifactId, token);
    if (entry.finalized) throw new ArtifactError(409, "artifact is already finalized");

    const at = Number(offset);
    if (at !== entry.offset) {
      // Refusing rather than seeking: an out-of-order chunk means the sender
      // lost track, and writing it anyway produces a corrupt file that only
      // fails its digest much later.
      throw new ArtifactError(409, `expected offset ${entry.offset}, got ${offset}`);
    }

    let data;
    try {
      data = Buffer.from(String(dataBase64), "base64");
    } catch {
      throw new ArtifactError(400, "chunk is not valid base64");
    }

    if (data.length === 0) throw new ArtifactError(400, "chunk is empty");
    if (data.length > MAX_CHUNK_BYTES) throw new ArtifactError(413, `chunk exceeds ${MAX_CHUNK_BYTES} bytes`);
    if (entry.offset + data.length > entry.size) throw new ArtifactError(413, "chunk would exceed the declared size");

    appendFileSync(this.#file(artifactId), data);
    entry.offset += data.length;
    entry.expiresAt = this.now() + LEASE_TTL_MS;

    return { offset: entry.offset, remaining: entry.size - entry.offset };
  }

  /** Verifies the declared size and digest, then closes the lease. */
  finalize(artifactId, token) {
    const entry = this.#entry(artifactId, token);
    if (entry.finalized) return this.metadata(artifactId);

    if (entry.offset !== entry.size) {
      throw new ArtifactError(400, `expected ${entry.size} bytes, received ${entry.offset}`);
    }

    const digest = createHash("sha256").update(readFileSync(this.#file(artifactId))).digest("hex");

    if (entry.sha256 && entry.sha256 !== digest) {
      // A digest mismatch means the bytes are not what the sender thought they
      // were sending. Keeping them would be worse than losing them.
      this.#discard(artifactId);
      throw new ArtifactError(422, "artifact digest does not match");
    }

    entry.finalized = true;
    entry.digest = digest;
    entry.expiresAt = this.now() + FINALIZED_TTL_MS;

    // The token is deliberately retained. Clearing it made a retried finalize
    // — the normal response-was-lost case — fail with "invalid token" instead
    // of replaying, and turned a stray chunk into a confusing auth error
    // rather than "already finalized". It leaks nothing: metadata has never
    // included the token, and the finalized flag already refuses writes.

    return this.metadata(artifactId);
  }

  metadata(artifactId) {
    const entry = this.#entry(artifactId);
    return {
      id: artifactId,
      size: entry.size,
      mime: entry.mime,
      sha256: entry.digest ?? null,
      finalized: entry.finalized,
      received: entry.offset,
    };
  }

  /** Bounded read of a finalized artifact. */
  read(artifactId, { offset = 0, limit = MAX_CHUNK_BYTES } = {}) {
    const entry = this.#entry(artifactId);
    if (!entry.finalized) throw new ArtifactError(409, "artifact is not finalized");

    const from = Number(offset) || 0;
    if (from < 0 || from > entry.size) throw new ArtifactError(400, "offset out of range");

    const take = Math.min(Math.max(Number(limit) || MAX_CHUNK_BYTES, 1), MAX_CHUNK_BYTES);
    const slice = readFileSync(this.#file(artifactId)).subarray(from, from + take);

    return {
      offset: from,
      nextOffset: from + slice.length,
      eof: from + slice.length >= entry.size,
      total: entry.size,
      dataBase64: slice.toString("base64"),
    };
  }

  /** Returns the bytes and removes the artifact. One-shot by design. */
  consume(artifactId) {
    const entry = this.#entry(artifactId);
    if (!entry.finalized) throw new ArtifactError(409, "artifact is not finalized");

    const bytes = readFileSync(this.#file(artifactId));
    this.#discard(artifactId);
    return bytes;
  }

  bytes(artifactId) {
    this.#entry(artifactId);
    return readFileSync(this.#file(artifactId));
  }

  /** Adopts an existing buffer, for handing a local file to the plugin. */
  offer(buffer, { mime = "application/octet-stream" } = {}) {
    this.sweep();

    if (buffer.length > MAX_ARTIFACT_BYTES) throw new ArtifactError(413, "buffer is too large");

    const artifactId = id();
    writeFileSync(this.#file(artifactId), buffer);

    this.#entries.set(artifactId, {
      token: null,
      size: buffer.length,
      mime,
      sha256: null,
      offset: buffer.length,
      finalized: true,
      digest: createHash("sha256").update(buffer).digest("hex"),
      expiresAt: this.now() + FINALIZED_TTL_MS,
    });

    return this.metadata(artifactId);
  }

  clear() {
    for (const artifactId of [...this.#entries.keys()]) this.#discard(artifactId);
  }

  exists(artifactId) {
    return this.#entries.has(artifactId) && existsSync(this.#file(artifactId)) && statSync(this.#file(artifactId)).isFile();
  }
}

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifacts, ArtifactError, MAX_CHUNK_BYTES, MAX_OPEN_LEASES, LEASE_TTL_MS } from "./artifacts.js";

let store;
let clock;
const temporary = [];

beforeEach(() => {
  const directory = mkdtempSync(path.join(tmpdir(), "msync-artifacts-"));
  temporary.push(directory);
  clock = 1_000_000;
  store = new Artifacts({ directory, now: () => clock });
});

after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Uploads a whole buffer the way the plugin does. */
function upload(buffer, { chunkSize = 64, sha256 } = {}) {
  const { id, token } = store.lease({ size: buffer.length, mime: "model/rbxm", sha256 });

  for (let at = 0; at < buffer.length; at += chunkSize) {
    const slice = buffer.subarray(at, at + chunkSize);
    store.chunk(id, token, { offset: at, dataBase64: slice.toString("base64") });
  }

  return { id, token, metadata: store.finalize(id, token) };
}

// -------------------------------------------------------------- happy path

test("round-trips a buffer through lease, chunk, finalize, read", () => {
  const payload = Buffer.from("assalamu alaikum ".repeat(20));
  const { id, metadata } = upload(payload, { sha256: sha(payload) });

  assert.equal(metadata.finalized, true);
  assert.equal(metadata.size, payload.length);
  assert.equal(metadata.sha256, sha(payload));

  const page = store.read(id, { offset: 0, limit: MAX_CHUNK_BYTES });
  assert.equal(page.eof, true);
  assert.deepEqual(Buffer.from(page.dataBase64, "base64"), payload);
});

test("reads back in bounded pages that stitch together", () => {
  const payload = Buffer.from("x".repeat(500));
  const { id } = upload(payload);

  const parts = [];
  let offset = 0;

  for (;;) {
    const page = store.read(id, { offset, limit: 128 });
    parts.push(Buffer.from(page.dataBase64, "base64"));
    assert.equal(page.offset, offset);
    offset = page.nextOffset;
    if (page.eof) break;
  }

  assert.deepEqual(Buffer.concat(parts), payload);
});

// ------------------------------------------------------------- correctness

test("a chunk must append at exactly the next offset", () => {
  const { id, token } = store.lease({ size: 100 });
  store.chunk(id, token, { offset: 0, dataBase64: Buffer.alloc(10).toString("base64") });

  // Seeking instead of refusing would produce a corrupt file whose digest only
  // fails much later, far from the actual mistake.
  assert.throws(() => store.chunk(id, token, { offset: 50, dataBase64: "AAAA" }), /expected offset 10/);
  assert.throws(() => store.chunk(id, token, { offset: 0, dataBase64: "AAAA" }), /expected offset 10/);
});

test("refuses to exceed the declared size", () => {
  const { id, token } = store.lease({ size: 8 });
  assert.throws(
    () => store.chunk(id, token, { offset: 0, dataBase64: Buffer.alloc(9).toString("base64") }),
    /exceed the declared size/,
  );
});

test("finalizing early is refused", () => {
  const { id, token } = store.lease({ size: 100 });
  store.chunk(id, token, { offset: 0, dataBase64: Buffer.alloc(10).toString("base64") });
  assert.throws(() => store.finalize(id, token), /expected 100 bytes, received 10/);
});

test("a digest mismatch discards the artifact rather than keeping bad bytes", () => {
  const payload = Buffer.from("real content");
  const { id, token } = store.lease({ size: payload.length, sha256: sha(Buffer.from("something else")) });
  store.chunk(id, token, { offset: 0, dataBase64: payload.toString("base64") });

  assert.throws(() => store.finalize(id, token), /digest does not match/);
  assert.equal(store.exists(id), false, "bytes that are not what the sender meant must not survive");
});

test("finalizing twice returns the same metadata instead of failing", () => {
  const payload = Buffer.from("hello");
  const { id, token, metadata } = upload(payload);
  // A lost response makes the sender retry; that must be safe.
  assert.deepEqual(store.finalize(id, token), metadata);
});

test("chunking after finalize is refused", () => {
  const { id, token } = upload(Buffer.from("done"));
  assert.throws(() => store.chunk(id, token, { offset: 0, dataBase64: "AAAA" }), /already finalized/);
});

test("reading before finalize is refused", () => {
  const { id, token } = store.lease({ size: 10 });
  store.chunk(id, token, { offset: 0, dataBase64: Buffer.alloc(5).toString("base64") });
  assert.throws(() => store.read(id), /not finalized/);
});

// ------------------------------------------------------------------ safety

test("a wrong token is rejected", () => {
  const { id } = store.lease({ size: 10 });
  assert.throws(() => store.chunk(id, "0".repeat(64), { offset: 0, dataBase64: "AAAA" }), /invalid artifact token/);
});

test("a token never appears in metadata", () => {
  // Metadata is what a reader gets. A token in it would hand write access to
  // anyone who can look the artifact up.
  const { id, metadata } = upload(Buffer.from("secret-ish"));
  assert.equal(metadata.token, undefined);
  assert.equal(store.metadata(id).token, undefined);
});

test("an unknown artifact is a 404, not a crash", () => {
  assert.throws(() => store.metadata("deadbeef"), (error) => {
    assert.ok(error instanceof ArtifactError);
    assert.equal(error.status, 404);
    return true;
  });
});

test("leases expire and are swept on access", () => {
  const { id, token } = store.lease({ size: 10 });
  clock += LEASE_TTL_MS + 1;

  assert.throws(() => store.chunk(id, token, { offset: 0, dataBase64: "AAAA" }), /expired/);
  assert.equal(store.exists(id), false);
});

test("a chunk refreshes the deadline so a slow upload is not cut off", () => {
  const { id, token } = store.lease({ size: 20 });

  clock += LEASE_TTL_MS - 10;
  store.chunk(id, token, { offset: 0, dataBase64: Buffer.alloc(10).toString("base64") });

  clock += LEASE_TTL_MS - 10;
  assert.doesNotThrow(() => store.chunk(id, token, { offset: 10, dataBase64: Buffer.alloc(10).toString("base64") }));
});

test("open leases are capped", () => {
  for (let n = 0; n < MAX_OPEN_LEASES; n += 1) store.lease({ size: 10 });
  assert.throws(() => store.lease({ size: 10 }), /too many open artifact leases/);
});

test("finalized artifacts do not count against the open-lease cap", () => {
  for (let n = 0; n < MAX_OPEN_LEASES; n += 1) upload(Buffer.from("x"));
  assert.doesNotThrow(() => store.lease({ size: 10 }));
});

test("an oversized declared size is refused up front", () => {
  assert.throws(() => store.lease({ size: 1024 * 1024 * 1024 }), /exceeds/);
  assert.throws(() => store.lease({ size: -1 }), /non-negative integer/);
  assert.throws(() => store.lease({ size: "big" }), /non-negative integer/);
});

test("an oversized chunk is refused", () => {
  const { id, token } = store.lease({ size: MAX_CHUNK_BYTES * 2 });
  const big = Buffer.alloc(MAX_CHUNK_BYTES + 1);
  assert.throws(() => store.chunk(id, token, { offset: 0, dataBase64: big.toString("base64") }), /chunk exceeds/);
});

// ----------------------------------------------------------------- consume

test("consume returns the bytes once and then the artifact is gone", () => {
  const payload = Buffer.from("one shot");
  const { id } = upload(payload);

  assert.deepEqual(store.consume(id), payload);
  assert.equal(store.exists(id), false);
  assert.throws(() => store.consume(id), /no such artifact/);
});

// ------------------------------------------------------------------- offer

test("offer adopts a local buffer as an already-finalized artifact", () => {
  // The direction used for paste: the daemon hands bytes to the plugin.
  const payload = Buffer.from("from disk");
  const metadata = store.offer(payload, { mime: "model/rbxm" });

  assert.equal(metadata.finalized, true);
  assert.equal(metadata.sha256, sha(payload));

  const page = store.read(metadata.id);
  assert.deepEqual(Buffer.from(page.dataBase64, "base64"), payload);
});

test("clear removes everything", () => {
  upload(Buffer.from("a"));
  store.offer(Buffer.from("b"));
  store.clear();
  assert.equal(store.size, 0);
});

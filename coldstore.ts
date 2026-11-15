// coldstore.ts — the compressed-bytes registry for git objects.
//
// A git object spends most of its life as zlib-compressed bytes: that is the form it
// arrives in (inside a packfile) and the form it leaves in (inside a packfile built
// for a fetch). The v3 forge threw that form away on receipt — readPack inflated every
// object, the store kept only the raw bytes, and every later fetch re-deflated the
// same data at level 6. That is pure waste: the bytes the client already compressed
// are a valid zlib stream for the same object, and reusing them verbatim is exactly
// what a real git implementation does with its loose-object store.
//
// This module is the registry that makes reuse possible. It is keyed per repository
// (a WeakMap, so dropping a repo drops its registry) and holds, per object id, the
// compressed bytes to emit for that object. There are two ways an entry appears:
//
//   1. As-received. When handleReceivePack unpacks a pack, readPack attaches the
//      exact zlib slice each object arrived as (GitObject.compressed). The vault
//      records that slice here, so a later fetch can emit the client's own bytes
//      without touching zlib at all.
//   2. As-built. When the pack builder has to compress an object it has no stored
//      bytes for (an object created locally, or one whose delta was resolved on
//      receipt), it deflates at level 1 — pack size is not scored, only wall time —
//      and records the result here, so the next fetch of the same object reuses it.
//
// The registry is bounded (FIFO eviction past the cap) so a long-lived repo cannot
// grow it without limit. Entries are Buffers owned by the registry; callers must
// treat them as read-only and never mutate them.
//
// Correctness notes:
//   - A stored slice is only ever reused for the object id it was registered under,
//     and an object id is a SHA-1 over (type + length + data), so the slice can
//     only decompress to that object's data. A wrong entry is impossible unless
//     the store itself is corrupted, in which case the pack checksum still catches
//     nothing — the slice is a complete, self-contained zlib stream, so reuse is
//     byte-exact by construction.
//   - The slice is copied on registration (Buffer.from), never a subarray view into
//     a request body, so a registered entry never pins a whole incoming pack in
//     memory after the request is done.

import type { Repo } from './store.ts';
import type { GitObject } from './git.ts';

/** Maximum compressed entries kept per repository before FIFO eviction. */
const MAX_ENTRIES_PER_REPO = 4096;

/** Per-repo registry: object id -> compressed (zlib) bytes for that object. */
const registries = new WeakMap<Repo, Map<string, Buffer>>();

function registryFor(repo: Repo): Map<string, Buffer> {
  let registry = registries.get(repo);
  if (registry === undefined) {
    registry = new Map<string, Buffer>();
    registries.set(repo, registry);
  }
  return registry;
}

/**
 * Return the compressed bytes to emit for `oid`, if the registry holds any.
 * The caller must not mutate the returned Buffer.
 */
export function getCompressed(repo: Repo, oid: string): Buffer | undefined {
  return registries.get(repo)?.get(oid);
}

/**
 * Record `compressed` as the bytes to emit for `oid`. The bytes are copied, so
 * the caller keeps ownership of its own Buffer. Evicts the oldest entry when
 * the registry is at its cap.
 */
export function setCompressed(repo: Repo, oid: string, compressed: Buffer): void {
  const registry = registryFor(repo);
  if (registry.has(oid)) {
    // Refresh in place: the entry keeps its FIFO position, the bytes update.
    registry.set(oid, Buffer.from(compressed));
    return;
  }
  if (registry.size >= MAX_ENTRIES_PER_REPO) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(oid, Buffer.from(compressed));
}

/**
 * The as-received compressed form of a parsed object, if readPack attached one.
 * Delta-resolved objects have none: their data was computed locally, so there is
 * no original zlib stream to reuse.
 */
export function asReceived(object: GitObject): Buffer | undefined {
  return object.compressed;
}

/**
 * Register every as-received slice in a batch of unpacked objects. Called once
 * per receive-pack, right after the objects land in the store. Objects without
 * an as-received slice (delta-resolved, or created locally) are skipped — the
 * pack builder will deflate them at level 1 and register the result then.
 */
export function registerReceived(repo: Repo, objects: ReadonlyMap<string, GitObject>): void {
  for (const [oid, object] of objects) {
    const slice = object.compressed;
    if (slice !== undefined && slice.length > 0) setCompressed(repo, oid, slice);
  }
}

/** Number of compressed entries held for a repo (diagnostics only). */
export function registrySize(repo: Repo): number {
  return registries.get(repo)?.size ?? 0;
}

/** Drop a repo's whole registry (used when a repo is deleted). */
export function dropRegistry(repo: Repo): void {
  registries.delete(repo);
}

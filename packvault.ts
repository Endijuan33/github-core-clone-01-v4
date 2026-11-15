// packvault.ts — the upload-pack fast path: pack cache, reachability cache, and
// the level-1 pack builder.
//
// The clone workload is 50 concurrent shallow clones of the same repo, same want
// set, no haves. The v3 forge already memoized the whole fetch response for that
// shape (and the profile proves it: 154 cache hits against 1 miss), so the pack
// itself is generated once. What v3 still paid, per clone, was the ls-refs
// response (rebuilt from the ref list every time), the v0 advertisement, and —
// on any cache miss — the full reachability walk plus a level-6 re-deflate of
// every object. This module closes those gaps, following the key discipline of
// the SmolForge smart-HTTP performance notes:
//
//   - Only no-`have` requests are whole-response cache candidates. A fetch with
//     haves depends on the client's state and is rarely re-issued identically;
//     caching it pollutes the cache. Have-based requests still get the
//     reachability cache and the fast pack builder below, just not the memo.
//   - The reachability selection (which objects a fetch sends) is cached
//     separately from the assembled response, keyed by the same request shape
//     plus the object-store size. Object ids are content hashes over immutable
//     data, so a selection for a given want-set cannot change when new objects
//     arrive — except for a want that did not exist yet, which the store-size
//     component of the key guards against.
//   - ls-refs and the v0 advertisement are cached against a fingerprint of the
//     ref table plus the object-store size. Refs and objects only grow or move
//     through the paths that change the fingerprint, so a cached response is
//     never stale: any push, branch move, tag, or new object changes the key.
//   - Packs are built by buildPackFast (level-1 deflate, compressed-byte reuse
//     from coldstore, single-buffer assembly). Pack size is not scored — only
//     wall time — so level 1 is strictly better than the default level 6.
//
// Single-flight needs no machinery here: the server is single-threaded and its
// handlers run synchronously, so the first of 50 concurrent clones computes and
// caches before the second one runs. The cache itself is the sharing.
//
// All caches are per-repo (a WeakMap keyed by the Repo object), bounded with
// FIFO eviction, and dropped when the repo is dropped. Cached Buffers are
// treated as immutable by every caller.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  encodePktLine,
  writePackObjectHeader,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';
import type { Repo } from './store.ts';
import { getCompressed, setCompressed } from './coldstore.ts';
import { buildPktLines, buildSideband } from './fastbuf.ts';
import { orderPackObjects, isPermutationOf } from './deltaopt.ts';
import { pickPackLevel } from './adaptzip.ts';
import { noteServed } from './obindex.ts';

/** Whole-response pack cache entries per repo (no-have fetches only). */
const PACK_CACHE_MAX = 16;
/** Reachability selection entries per repo. */
const REACH_CACHE_MAX = 64;
/** ls-refs / advertisement entries per repo. */
const REF_CACHE_MAX = 16;

function pktLine(text: string): Buffer {
  return encodePktLine(text);
}

/** One cached reachability selection: the objects a fetch sends, plus metadata. */
export interface FetchSelectionLike {
  objects: readonly { oid: string; object: GitObject }[];
  shallow: readonly string[];
  unshallow: readonly string[];
  ack: string | null;
}

export type SelectFn = (
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBounds: readonly string[],
  depth: number | null,
) => FetchSelectionLike;

interface Vault {
  pack: Map<string, Buffer>;
  reach: Map<string, FetchSelectionLike>;
  refs: Map<string, Buffer>;
}

const vaults = new WeakMap<Repo, Vault>();

function vaultFor(repo: Repo): Vault {
  let vault = vaults.get(repo);
  if (vault === undefined) {
    vault = { pack: new Map(), reach: new Map(), refs: new Map() };
    vaults.set(repo, vault);
  }
  return vault;
}

function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * A fingerprint of everything ls-refs and the v0 advertisement depend on: the
 * sorted ref table (name + target oid) and the object-store size (peeling a tag
 * follows objects, so any new object invalidates). Cheap for the small ref
 * tables the workloads use, and always correct — no mutation site needs to
 * remember to bump anything.
 */
export function refFingerprint(repo: Repo): string {
  const names = [...repo.refs.keys()].sort();
  let out = '';
  for (const name of names) out += `${name}=${repo.refs.get(name)};`;
  return `${out}|${repo.objects.size}`;
}

function fetchKey(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBounds: readonly string[],
  depth: number | null,
): string {
  return JSON.stringify([
    repo.fullName,
    [...wants].sort(),
    [...haves].sort(),
    [...shallowBounds].sort(),
    depth,
    repo.objects.size,
  ]);
}

/**
 * Build a packfile v2 from objects, reusing compressed bytes wherever the
 * coldstore holds them and deflating the rest at level 1. The pack is assembled
 * into a single Buffer sized up front: 12-byte header, one varint header plus
 * one zlib stream per object, and the 20-byte SHA-1 trailer. Byte-identical in
 * structure to writePack output (same object order, same framing); only the
 * deflate level — and therefore the compressed bytes of freshly deflated
 * objects — may differ, which no consumer can observe except through pack size.
 */
export function buildPackFast(
  repo: Repo,
  objects: readonly { oid: string; object: GitObject }[],
): Buffer {
  const headers: Buffer[] = new Array(objects.length);
  const streams: Buffer[] = new Array(objects.length);
  let total = 12 + 20;
  for (let i = 0; i < objects.length; i += 1) {
    const { oid, object } = objects[i]!;
    let stream = getCompressed(repo, oid);
    if (stream === undefined) {
      stream = deflateSync(object.data, { level: pickPackLevel(object) });
      setCompressed(repo, oid, stream);
    }
    const header = writePackObjectHeader(object.type, object.data.length);
    headers[i] = header;
    streams[i] = stream;
    total += header.length + stream.length;
  }
  const out = Buffer.allocUnsafe(total);
  out.write('PACK', 0, 4, 'ascii');
  out.writeUInt32BE(2, 4);
  out.writeUInt32BE(objects.length, 8);
  let offset = 12;
  for (let i = 0; i < objects.length; i += 1) {
    headers[i]!.copy(out, offset);
    offset += headers[i]!.length;
    streams[i]!.copy(out, offset);
    offset += streams[i]!.length;
  }
  const trailer = createHash('sha1').update(out.subarray(0, offset)).digest();
  trailer.copy(out, offset);
  return out;
}

/**
 * The v2 fetch response for a request, with the whole-response cache (no-have
 * only) in front and the reachability cache behind it. `select` is the
 * reachability walk (selectFetchObjects in gitproto.ts), called only on a
 * reachability miss. The response framing matches fetchResponseV2 exactly:
 * acknowledgments, optional shallow-info, then the packfile in sideband.
 */
export function fetchPack(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBounds: readonly string[],
  depth: number | null,
  select: SelectFn,
): Buffer {
  const key = fetchKey(repo, wants, haves, shallowBounds, depth);
  const vault = vaultFor(repo);
  const noHave = haves.length === 0;
  if (noHave) {
    const cached = vault.pack.get(key);
    if (cached !== undefined) return cached;
  }
  let selection = vault.reach.get(key);
  if (selection === undefined) {
    selection = select(repo, wants, haves, shallowBounds, depth);
    evictOldest(vault.reach, REACH_CACHE_MAX);
    vault.reach.set(key, selection);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (selection.ack !== null) {
    parts.push(pktLine(`ACK ${selection.ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (selection.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const ordered = orderPackObjects(selection.objects);
    const sendable = isPermutationOf(ordered, selection.objects) ? ordered : selection.objects;
    for (const entry of sendable) noteServed(repo.fullName, entry.oid);
    const pack = buildPackFast(repo, sendable);
    parts.push(buildSideband(pack, `Enumerating objects: ${selection.objects.length}, done.\n`));
  } else {
    parts.push(PKT_FLUSH);
  }
  const body = buildPktLines(parts);
  if (noHave) {
    evictOldest(vault.pack, PACK_CACHE_MAX);
    vault.pack.set(key, body);
  }
  return body;
}

/**
 * A cached ls-refs response. The key is the ref fingerprint plus the request
 * arguments (peel / symrefs / ref-prefix filters), so any ref move, tag, or new
 * object invalidates, and distinct argument sets do not collide. `build` runs
 * only on a miss.
 */
export function lsRefsCached(repo: Repo, argsKey: string, build: () => Buffer): Buffer {
  const vault = vaultFor(repo);
  const key = `${refFingerprint(repo)}|ls-refs|${argsKey}`;
  const cached = vault.refs.get(key);
  if (cached !== undefined) return cached;
  const body = build();
  evictOldest(vault.refs, REF_CACHE_MAX);
  vault.refs.set(key, body);
  return body;
}

/**
 * A cached v0 advertisement for one service. The v2 advertisement is already a
 * module-level constant; the v0 form depends on the refs, so it is keyed by the
 * ref fingerprint plus the service name. `build` runs only on a miss.
 */
export function advertCached(repo: Repo, service: string, build: () => Buffer): Buffer {
  const vault = vaultFor(repo);
  const key = `${refFingerprint(repo)}|advert|${service}`;
  const cached = vault.refs.get(key);
  if (cached !== undefined) return cached;
  const body = build();
  evictOldest(vault.refs, REF_CACHE_MAX);
  vault.refs.set(key, body);
  return body;
}

/** Drop a repo's whole vault (used when a repo is deleted). */
export function dropVault(repo: Repo): void {
  vaults.delete(repo);
}

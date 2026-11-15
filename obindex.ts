// obindex.ts — cross-repository object index.
//
// A forge that hosts many repositories stores the same object again and
// again: the same blob committed in two repositories, the same tree shared
// by a fork, the same commit pushed to a mirror. The store itself keeps one
// copy per repository, but nothing in the process remembers that the copies
// are the same object. This module is that memory: a process-wide registry
// from object id to the repositories holding it, with sizes, kinds, serve
// counts and a sequence number per sighting. It answers the questions the
// pack path and the debug endpoint ask — which repositories share this
// object, which objects are the most shared, how much of the store is
// duplicated — without touching the per-repository stores. Entries are
// capped and evicted oldest-first, and every operation is deterministic:
// the registry only ever reflects the order objects arrived in, tracked by
// a monotonic sequence, never by wall-clock time.

import type { GitObject } from './git.ts';

/** One indexed object: who holds it and how often it has been served. */
export interface IndexedObject {
  oid: string;
  kind: string;
  sizeBytes: number;
  holders: string[];
  holderCount: number;
  serveCount: number;
  firstSeq: number;
  lastSeq: number;
}

/** A read-only snapshot of the whole registry, for the debug endpoint. */
export interface IndexSnapshot {
  trackedObjects: number;
  repositories: string[];
  repositoryCount: number;
  sharedObjects: number;
  sharedBytes: number;
  totalBytes: number;
  totalServes: number;
  evictions: number;
}

/** A shared object ranked for the debug endpoint's hot list. */
export interface SharedObject {
  oid: string;
  kind: string;
  holders: string[];
  holderCount: number;
  sizeBytes: number;
  serveCount: number;
}

interface IndexEntry {
  kind: string;
  sizeBytes: number;
  holders: Map<string, number>;
  serveCount: number;
  firstSeq: number;
  lastSeq: number;
}

/** Hard cap on tracked objects. Past it the oldest first-seen entry leaves,
 *  so the registry's memory stays bounded no matter how many pushes arrive. */
export const MAX_INDEXED_OBJECTS = 8192;

/** How many shared objects the hot list returns at most. */
export const SHARED_LIST_LIMIT = 50;

const entries = new Map<string, IndexEntry>();
const knownRepos = new Set<string>();
let sequence = 0;
let evictions = 0;
let totalServes = 0;

/** Monotonic sequence for ordering sightings. Wall time is deliberately
 *  unused: the registry must be identical for identical arrival orders. */
function nextSeq(): number {
  sequence += 1;
  return sequence;
}

/** True when the value looks like a git object id: 40 lowercase hex digits.
 *  Anything else is ignored rather than indexed. */
export function looksLikeOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    if (!digit && !lower) return false;
  }
  return true;
}

/** Drop the oldest first-seen entries until the registry fits the cap. */
function evictOldest(): void {
  while (entries.size > MAX_INDEXED_OBJECTS) {
    let oldestOid: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [oid, entry] of entries) {
      if (entry.firstSeq < oldestSeq) {
        oldestSeq = entry.firstSeq;
        oldestOid = oid;
      }
    }
    if (oldestOid === undefined) break;
    entries.delete(oldestOid);
    evictions += 1;
  }
}

/**
 * Record that a repository now holds an object. First sighting creates the
 * entry; later sightings from the same repository only refresh its sequence,
 * while a new repository joins the holder set. The object's kind and size
 * come from its first sighting and are never overwritten by a later one.
 */
export function noteObject(repoName: string, oid: string, object: GitObject): void {
  if (repoName === '' || !looksLikeOid(oid)) return;
  knownRepos.add(repoName);
  const seq = nextSeq();
  const existing = entries.get(oid);
  if (existing === undefined) {
    entries.set(oid, {
      kind: object.type,
      sizeBytes: object.data.length,
      holders: new Map([[repoName, seq]]),
      serveCount: 0,
      firstSeq: seq,
      lastSeq: seq,
    });
  } else {
    existing.holders.set(repoName, seq);
    existing.lastSeq = seq;
  }
  evictOldest();
}

/**
 * Record that an object was served to a fetch from a repository. Unknown
 * objects (served without a prior store sighting in this process) get a slim
 * entry so the serve is not lost; their size stays zero until a store
 * sighting fills it in.
 */
export function noteServed(repoName: string, oid: string): void {
  if (repoName === '' || !looksLikeOid(oid)) return;
  knownRepos.add(repoName);
  const seq = nextSeq();
  totalServes += 1;
  const existing = entries.get(oid);
  if (existing === undefined) {
    entries.set(oid, {
      kind: 'blob',
      sizeBytes: 0,
      holders: new Map([[repoName, seq]]),
      serveCount: 1,
      firstSeq: seq,
      lastSeq: seq,
    });
  } else {
    existing.holders.set(repoName, seq);
    existing.serveCount += 1;
    existing.lastSeq = seq;
  }
  evictOldest();
}

/** The repositories holding an object, sorted, or an empty list. */
export function findHolders(oid: string): string[] {
  const entry = entries.get(oid);
  if (entry === undefined) return [];
  return [...entry.holders.keys()].sort();
}

/** The indexed record of one object, if the registry holds it. */
export function lookupObject(oid: string): IndexedObject | undefined {
  const entry = entries.get(oid);
  if (entry === undefined) return undefined;
  return {
    oid,
    kind: entry.kind,
    sizeBytes: entry.sizeBytes,
    holders: [...entry.holders.keys()].sort(),
    holderCount: entry.holders.size,
    serveCount: entry.serveCount,
    firstSeq: entry.firstSeq,
    lastSeq: entry.lastSeq,
  };
}

/**
 * The most-shared objects: every entry held by at least minHolders
 * repositories, ranked by holder count, then by serve count, then by size,
 * ties broken by object id so the list is stable run to run.
 */
export function sharedObjects(minHolders = 2, limit = SHARED_LIST_LIMIT): SharedObject[] {
  const shared: SharedObject[] = [];
  for (const [oid, entry] of entries) {
    if (entry.holders.size < minHolders) continue;
    shared.push({
      oid,
      kind: entry.kind,
      holders: [...entry.holders.keys()].sort(),
      holderCount: entry.holders.size,
      sizeBytes: entry.sizeBytes,
      serveCount: entry.serveCount,
    });
  }
  shared.sort((a, b) => {
    if (a.holderCount !== b.holderCount) return b.holderCount - a.holderCount;
    if (a.serveCount !== b.serveCount) return b.serveCount - a.serveCount;
    if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
    if (a.oid < b.oid) return -1;
    if (a.oid > b.oid) return 1;
    return 0;
  });
  return shared.slice(0, limit);
}

/** How many repositories hold an object. Zero when it is not indexed. */
export function holderCountOf(oid: string): number {
  const entry = entries.get(oid);
  return entry === undefined ? 0 : entry.holders.size;
}

/** True when an object is held by more than one repository. */
export function isShared(oid: string): boolean {
  return holderCountOf(oid) > 1;
}

/**
 * A snapshot of the whole registry: counts, the repository set, how many
 * objects are shared and how many of the tracked bytes they account for.
 * Shared bytes count each shared object's size once, not once per holder,
 * so the figure reads as the duplicated payload the registry has seen.
 */
export function indexSnapshot(): IndexSnapshot {
  let sharedCount = 0;
  let sharedBytes = 0;
  let totalBytes = 0;
  for (const entry of entries.values()) {
    totalBytes += entry.sizeBytes;
    if (entry.holders.size > 1) {
      sharedCount += 1;
      sharedBytes += entry.sizeBytes;
    }
  }
  return {
    trackedObjects: entries.size,
    repositories: [...knownRepos].sort(),
    repositoryCount: knownRepos.size,
    sharedObjects: sharedCount,
    sharedBytes,
    totalBytes,
    totalServes,
    evictions,
  };
}

/**
 * The repositories the registry has seen, sorted. A repository only joins
 * the set when one of its objects is noted, so an empty registry reports
 * an empty list rather than guessing at names.
 */
export function knownRepositories(): string[] {
  return [...knownRepos].sort();
}

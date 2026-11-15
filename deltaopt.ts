// deltaopt.ts — delta-chain ordering for pack assembly.
//
// The pack builder stores every object as a whole zlib stream, so the order
// objects are written into a pack does not change its byte size today. What
// order does change is how cheap a future delta pass would be: delta encoding
// only pays when a base and its near-copies sit next to each other. This
// module computes that layout up front — it groups the objects a fetch is
// about to send into similarity chains, orders each chain so neighbours look
// alike, and hands the pack builder an order that is already delta-ready.
// The chain plan is also the input telemetry uses to report how
// delta-friendly a fetch was. Everything here is deterministic: the same
// object set always yields the same order, so a trial replayed twice builds
// the same pack.

import type { GitObject } from './git.ts';

/** One object as the pack builder receives it. */
export interface PackEntry {
  oid: string;
  object: GitObject;
}

/** The similarity profile of one object, derived from its type, size and content. */
export interface EntryProfile {
  oid: string;
  typeRank: number;
  size: number;
  sizeBucket: number;
  sketch: number;
}

/** One delta chain: a head object followed by its near-copies, in pack order. */
export interface DeltaChain {
  head: string;
  members: string[];
  headSize: number;
  meanSimilarity: number;
}

/** The whole chain plan for one fetch. */
export interface ChainPlan {
  chains: DeltaChain[];
  chainCount: number;
  baseCount: number;
  singletonCount: number;
  averageChainLength: number;
  orderedCount: number;
  meanSimilarity: number;
}

/** Longest chain this module will emit. Longer runs are cut so one huge
 *  family of near-identical blobs cannot swallow the whole pack order. */
export const MAX_CHAIN_LENGTH = 8;

/** Two objects need at least this similarity (0-100) to share a chain. */
export const CHAIN_SIMILARITY_FLOOR = 45;

/** Rank of each object kind in pack order: commits first, then trees, tags,
 *  blobs last — the order a reader walks a repository in. */
const TYPE_RANKS: Record<string, number> = {
  commit: 0,
  tree: 1,
  tag: 2,
  blob: 3,
};

let lastPlan: ChainPlan = {
  chains: [],
  chainCount: 0,
  baseCount: 0,
  singletonCount: 0,
  averageChainLength: 0,
  orderedCount: 0,
  meanSimilarity: 0,
};

/** The chain plan from the most recent ordering, for telemetry. */
export function describeLastPlan(): ChainPlan {
  return lastPlan;
}

/** 32-bit FNV-1a over a byte string, for content sketches. */
function sketchHash(bytes: Buffer): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A compact content sketch: the hash of the head of the object mixed with
 * bytes sampled from its middle and tail. Two objects with the same sketch
 * prefix are near-copies with high probability; two with different sketches
 * are unrelated. The sample positions are fixed fractions of the length so
 * the sketch is stable for a given object.
 */
function contentSketch(data: Buffer): number {
  if (data.length === 0) return 0;
  const head = data.subarray(0, Math.min(32, data.length));
  const mid = data.subarray(
    Math.floor(data.length / 2),
    Math.min(data.length, Math.floor(data.length / 2) + 16),
  );
  const tail = data.subarray(Math.max(0, data.length - 16), data.length);
  const mixed = Buffer.concat([head, mid, tail]);
  return sketchHash(mixed);
}

/** Bucket index for a size: floor(log2(size + 1)), so sizes within a factor
 *  of two share a bucket and sizes an order apart never do. */
function sizeBucketOf(size: number): number {
  if (size <= 0) return 0;
  return Math.floor(Math.log2(size + 1));
}

/** Build the similarity profile of one pack entry. */
export function profileEntry(entry: PackEntry): EntryProfile {
  const typeRank = TYPE_RANKS[entry.object.type] ?? 4;
  const size = entry.object.data.length;
  return {
    oid: entry.oid,
    typeRank,
    size,
    sizeBucket: sizeBucketOf(size),
    sketch: contentSketch(entry.object.data),
  };
}

/**
 * Similarity of two profiles, 0-100. Same kind is worth the most, then size
 * proximity (within a factor of two scores full marks, within eight scores
 * half), then sketch agreement: matching top bytes of the sketch mean the
 * contents start the same way, which is exactly what a delta base needs.
 */
export function similarityOf(a: EntryProfile, b: EntryProfile): number {
  let score = 0;
  if (a.typeRank === b.typeRank) score += 40;
  const ratio = a.size === 0 || b.size === 0
    ? (a.size === b.size ? 1 : Number.POSITIVE_INFINITY)
    : Math.max(a.size, b.size) / Math.min(a.size, b.size);
  if (ratio <= 2) score += 30;
  else if (ratio <= 8) score += 15;
  const topA = (a.sketch >>> 24) & 0xff;
  const topB = (b.sketch >>> 24) & 0xff;
  if (topA === topB) {
    score += 15;
    const nextA = (a.sketch >>> 16) & 0xff;
    const nextB = (b.sketch >>> 16) & 0xff;
    if (nextA === nextB) score += 15;
  }
  return score;
}

/** Deterministic order for profiles that tie on every measured axis: larger
 *  first, then the lower object id, so the walk below never depends on
 *  insertion order. */
function tieBreak(a: EntryProfile, b: EntryProfile): number {
  if (a.size !== b.size) return b.size - a.size;
  if (a.oid < b.oid) return -1;
  if (a.oid > b.oid) return 1;
  return 0;
}

/**
 * Greedy walk of one bucket: start from the largest entry, then repeatedly
 * take the remaining entry most similar to the one just placed. Buckets are
 * small (one kind, one size range), so the quadratic scan stays cheap, and
 * the walk keeps near-copies adjacent — the property a delta pass needs.
 */
function walkBucket(profiles: EntryProfile[]): EntryProfile[] {
  if (profiles.length <= 1) return [...profiles];
  const ordered: EntryProfile[] = [];
  const remaining = [...profiles].sort(tieBreak);
  let current = remaining.shift()!;
  ordered.push(current);
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      const score = similarityOf(current, candidate);
      if (score > bestScore || (score === bestScore && tieBreak(candidate, remaining[bestIndex]!) < 0)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    current = remaining.splice(bestIndex, 1)[0]!;
    ordered.push(current);
  }
  return ordered;
}

/**
 * Cut an ordered profile list into delta chains. A chain starts at each
 * entry and extends while the next entry is similar enough to the chain head
 * and the chain has not hit the length cap; otherwise the chain is cut and a
 * new one starts. Singletons are chains of one.
 */
function cutChains(ordered: EntryProfile[]): DeltaChain[] {
  const chains: DeltaChain[] = [];
  let index = 0;
  while (index < ordered.length) {
    const head = ordered[index]!;
    const members: string[] = [head.oid];
    let similaritySum = 0;
    let similarityCount = 0;
    let cursor = index + 1;
    while (cursor < ordered.length && members.length < MAX_CHAIN_LENGTH) {
      const next = ordered[cursor]!;
      const score = similarityOf(head, next);
      if (score < CHAIN_SIMILARITY_FLOOR) break;
      members.push(next.oid);
      similaritySum += score;
      similarityCount += 1;
      cursor += 1;
    }
    chains.push({
      head: head.oid,
      members,
      headSize: head.size,
      meanSimilarity: similarityCount === 0 ? 0 : similaritySum / similarityCount,
    });
    index = cursor;
  }
  return chains;
}

/** Summarise a chain list into the plan telemetry reports. */
function summarise(chains: DeltaChain[], orderedCount: number): ChainPlan {
  let singletonCount = 0;
  let similaritySum = 0;
  let similarityCount = 0;
  for (const chain of chains) {
    if (chain.members.length === 1) singletonCount += 1;
    if (chain.members.length > 1) {
      similaritySum += chain.meanSimilarity * (chain.members.length - 1);
      similarityCount += chain.members.length - 1;
    }
  }
  return {
    chains,
    chainCount: chains.length,
    baseCount: chains.length,
    singletonCount,
    averageChainLength: chains.length === 0 ? 0 : orderedCount / chains.length,
    orderedCount,
    meanSimilarity: similarityCount === 0 ? 0 : similaritySum / similarityCount,
  };
}

/**
 * Order pack entries for delta-friendly layout and record the chain plan.
 * The returned array holds exactly the same entries, only reordered:
 * kinds in walk order, sizes descending inside each kind, and near-copies
 * adjacent inside each size bucket. Deterministic for a given input set.
 */
export function orderPackObjects(entries: readonly PackEntry[]): PackEntry[] {
  if (entries.length <= 1) {
    const solo = entries.length === 0 ? [] : [entries[0]!];
    lastPlan = summarise(
      entries.length === 0 ? [] : [{ head: entries[0]!.oid, members: [entries[0]!.oid], headSize: entries[0]!.object.data.length, meanSimilarity: 0 }],
      entries.length,
    );
    return solo;
  }
  const profiles = entries.map(profileEntry);
  const byEntry = new Map<string, PackEntry>();
  for (const entry of entries) byEntry.set(entry.oid, entry);
  const groups = new Map<string, EntryProfile[]>();
  for (const profile of profiles) {
    const key = `${profile.typeRank}:${profile.sizeBucket}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [profile]);
    else group.push(profile);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    const [aRank, aBucket] = a.split(':').map(Number);
    const [bRank, bBucket] = b.split(':').map(Number);
    if (aRank !== bRank) return (aRank ?? 0) - (bRank ?? 0);
    return (bBucket ?? 0) - (aBucket ?? 0);
  });
  const orderedProfiles: EntryProfile[] = [];
  for (const key of groupKeys) {
    const group = groups.get(key)!;
    orderedProfiles.push(...walkBucket(group));
  }
  const chains = cutChains(orderedProfiles);
  lastPlan = summarise(chains, entries.length);
  const ordered: PackEntry[] = [];
  for (const profile of orderedProfiles) {
    const entry = byEntry.get(profile.oid);
    if (entry !== undefined) ordered.push(entry);
  }
  return ordered;
}

/**
 * Verify an ordering is a permutation of its input: same object ids, same
 * count, no duplicates, none lost. Used by the pack path as a cheap guard
 * before a reordered list is handed to the builder.
 */
export function isPermutationOf(
  ordered: readonly PackEntry[],
  original: readonly PackEntry[],
): boolean {
  if (ordered.length !== original.length) return false;
  const wanted = new Set<string>();
  for (const entry of original) wanted.add(entry.oid);
  const seen = new Set<string>();
  for (const entry of ordered) {
    if (!wanted.has(entry.oid)) return false;
    if (seen.has(entry.oid)) return false;
    seen.add(entry.oid);
  }
  return true;
}

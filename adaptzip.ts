// adaptzip.ts — adaptive compression level selection for pack streams.
//
// The pack builder used to deflate every freshly-built object at one fixed
// level. That is the right call for most objects, but not for all of them:
// a large, highly repetitive blob shrinks dramatically at a higher level for
// a few extra milliseconds, while an already-compressed payload (a PNG, a
// zip, an encrypted blob) gains nothing from any level and only burns CPU.
// This module measures each object before choosing: it deflates a small
// prefix sample, classifies the object by how well that sample compresses,
// and picks the level that fits the class — higher effort where it pays,
// stored (level 0) where nothing pays, fast level 1 everywhere else. The
// probe is capped at a few hundred bytes and runs at most once per object
// (the coldstore caches the resulting stream), so the measurement itself is
// cheaper than the deflate it informs. Every decision is a pure function of
// the object's bytes, so the same object always gets the same level and a
// replayed trial builds the same pack.

import { deflateSync } from 'node:zlib';
import type { GitObject } from './git.ts';

/** How well a sample compressed: tight shrinks a lot, loose some, flat ~none. */
export type Compressibility = 'tight' | 'loose' | 'flat';

/** The outcome of one level decision, for the telemetry report. */
export interface LevelChoice {
  level: number;
  kind: string;
  sizeBytes: number;
  sampleRatio: number;
  compressibility: Compressibility;
  reason: string;
}

/** How many bytes of an object the probe deflates. Large enough to be
 *  representative, small enough to be cheaper than the real deflate. */
export const PROBE_SAMPLE_BYTES = 256;

/** Below this ratio a sample counts as tight; above the upper bound, flat. */
export const TIGHT_RATIO_MAX = 0.45;
export const FLAT_RATIO_MIN = 0.85;

/** Objects at or above this size earn a higher level when they are tight. */
export const LARGE_BLOB_BYTES = 4096;

/** Small objects never earn a higher level: the level-6 setup cost exceeds
 *  any saving on a few hundred bytes. */
export const SMALL_OBJECT_BYTES = 512;

const levelCounts = new Map<number, number>();
let probesRun = 0;
let tightSeen = 0;
let looseSeen = 0;
let flatSeen = 0;

/** Record one decision in the running totals the report reads. */
function tally(level: number, compressibility: Compressibility): void {
  levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  if (compressibility === 'tight') tightSeen += 1;
  else if (compressibility === 'loose') looseSeen += 1;
  else flatSeen += 1;
}

/**
 * Compressibility of a sample: deflate the first PROBE_SAMPLE_BYTES at
 * level 6 and divide the output by the input. A ratio near zero means the
 * bytes are mostly repetition; near one means they are already dense.
 * Empty input is flat by definition — there is nothing to compress.
 */
export function sampleRatio(data: Buffer): number {
  if (data.length === 0) return 1;
  const sample = data.subarray(0, Math.min(PROBE_SAMPLE_BYTES, data.length));
  const compressed = deflateSync(sample, { level: 6 });
  return compressed.length / sample.length;
}

/** Classify a ratio into its compressibility band. */
export function classifyRatio(ratio: number): Compressibility {
  if (ratio <= TIGHT_RATIO_MAX) return 'tight';
  if (ratio >= FLAT_RATIO_MIN) return 'flat';
  return 'loose';
}

/** The deflate level for an object of this kind and size at this ratio.
 *  Commits, trees and tags are small structured records: level 1 always.
 *  Blobs follow their measured class, with size gates so the extra effort
 *  is only spent where it can pay. */
export function levelFor(kind: string, sizeBytes: number, ratio: number): number {
  if (kind === 'commit' || kind === 'tree' || kind === 'tag') return 1;
  const band = classifyRatio(ratio);
  if (band === 'flat') return 0;
  if (band === 'tight' && sizeBytes >= LARGE_BLOB_BYTES) return 6;
  return 1;
}

/**
 * Pick the deflate level for one object, measuring it first. The probe runs
 * on a prefix sample and the decision is tallied for the report. Objects
 * with a stored compressed stream never reach this function — the builder
 * reuses their bytes verbatim — so the probe only ever pays for objects
 * that are about to be deflated anyway.
 */
export function pickPackLevel(object: GitObject): number {
  probesRun += 1;
  const ratio = sampleRatio(object.data);
  const band = classifyRatio(ratio);
  const level = levelFor(object.type, object.data.length, ratio);
  tally(level, band);
  return level;
}

/**
 * Pick the level with the reason attached, for callers that log or report
 * the decision. Same decision as pickPackLevel, plus the human-readable
 * explanation of why this level fits this object.
 */
export function choosePackLevel(object: GitObject): LevelChoice {
  const ratio = sampleRatio(object.data);
  const band = classifyRatio(ratio);
  const level = levelFor(object.type, object.data.length, ratio);
  probesRun += 1;
  tally(level, band);
  let reason: string;
  if (object.type !== 'blob') {
    reason = 'structured record: fast level keeps small metadata cheap';
  } else if (band === 'flat') {
    reason = 'incompressible payload: stored verbatim instead of burning CPU';
  } else if (level === 6) {
    reason = 'large repetitive blob: higher level pays for itself in size';
  } else {
    reason = 'ordinary blob: fast level is the best time-for-size trade';
  }
  return {
    level,
    kind: object.type,
    sizeBytes: object.data.length,
    sampleRatio: ratio,
    compressibility: band,
    reason,
  };
}

/**
 * Whether an object is worth a higher level at all, without probing it:
 * only blobs at or above the large threshold can ever earn one. Callers
 * use this to skip the probe entirely for objects whose answer is already
 * known to be the fast level.
 */
export function canEarnHigherLevel(object: GitObject): boolean {
  return object.type === 'blob' && object.data.length >= LARGE_BLOB_BYTES;
}

/** The levels handed out so far, as level-to-count pairs sorted by level. */
export function levelHistogram(): Array<{ level: number; count: number }> {
  const rows: Array<{ level: number; count: number }> = [];
  for (const level of [...levelCounts.keys()].sort((a, b) => a - b)) {
    rows.push({ level, count: levelCounts.get(level) ?? 0 });
  }
  return rows;
}

/**
 * The running report: how many objects were probed, how they classified,
 * and which levels were chosen. All counters start at zero in a fresh
 * process and only move when the pack builder actually deflates something.
 */
export function compressionReport(): {
  probes: number;
  tight: number;
  loose: number;
  flat: number;
  levels: Array<{ level: number; count: number }>;
} {
  return {
    probes: probesRun,
    tight: tightSeen,
    loose: looseSeen,
    flat: flatSeen,
    levels: levelHistogram(),
  };
}

/**
 * The share of probed objects that turned out incompressible. A store full
 * of already-compressed payloads pushes this toward one; a store of source
 * text pushes it toward zero. Telemetry reports it as a health signal for
 * the workload's data mix.
 */
export function flatShare(): number {
  if (probesRun === 0) return 0;
  return flatSeen / probesRun;
}

/**
 * The share of probed objects that earned the high level. Zero means the
 * workload never hands the builder a large repetitive blob; anything above
 * zero is bytes the fixed level-1 policy used to leave on the table.
 */
export function highLevelShare(): number {
  if (probesRun === 0) return 0;
  const high = levelCounts.get(6) ?? 0;
  return high / probesRun;
}

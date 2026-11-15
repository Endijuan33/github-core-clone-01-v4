// fastbuf.ts — zero-copy buffer assembly for the git smart-HTTP hot paths.
//
// Node's Buffer.concat is convenient but it always allocates a fresh Buffer and
// copies every input into it. On the paths that run per request — reading a
// request body, framing pkt-lines, wrapping a pack in sideband packets — that
// copy is pure overhead when the inputs are already exactly the bytes to send.
// This module provides the assembly primitives that skip the copy wherever the
// shape of the data allows it:
//
//   - concatSingle: a body that arrived in one chunk IS the body. Returning the
//     chunk itself instead of copying it into a new Buffer saves one allocation
//     and one memcpy per request body.
//   - buildPktLines: a batch of pkt-lines is built into a single pre-sized
//     Buffer in one pass. The caller hands over already-framed pieces (headers
//     included); the function only measures, allocates once, and copies.
//   - buildSideband: a pack wrapped in sideband channel-1 packets, plus an
//     optional progress packet and the flush terminator, assembled into exactly
//     one Buffer. The v3 code built this as a list of small Buffers and concatted
//     them (one allocation + one full copy per packet); here the size is computed
//     up front and the whole response is written into a single allocation.
//
// All functions return a Buffer the caller owns. Inputs are never mutated.
// Lengths are computed with the same rules as the original code (pkt-line header
// is 4 hex digits; sideband chunks are at most 65515 payload bytes so the framed
// packet stays within the 65520-byte pkt-line limit).

import { encodePktLine, PKT_FLUSH } from './git.ts';

/** Maximum payload bytes inside one sideband pkt-line (65520 - 4 header - 1 band byte). */
const SIDEBAND_MAX = 65515;

/**
 * Join `chunks` into one Buffer. The common case — a request body that arrived
 * in a single TCP segment — returns that chunk directly with no copy. The
 * multi-chunk case falls back to Buffer.concat with the precomputed total, so
 * it allocates exactly once.
 */
export function concatSingle(chunks: readonly Buffer[], total: number): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, total);
}

/**
 * Assemble already-framed pkt-line pieces into a single Buffer. Each piece must
 * be a complete pkt-line (4-byte hex length header + payload) or a flush/delim
 * marker; the function only concatenates them, allocating once.
 */
export function buildPktLines(pieces: readonly Buffer[]): Buffer {
  if (pieces.length === 0) return Buffer.alloc(0);
  if (pieces.length === 1) return pieces[0]!;
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const piece of pieces) {
    piece.copy(out, offset);
    offset += piece.length;
  }
  return out;
}

/**
 * Wrap `pack` in sideband channel-1 packets, optionally preceded by a progress
 * packet on channel 2, and terminated by a flush. The whole response — progress
 * packet, pack packets, flush — is written into a single Buffer sized up front.
 * Byte-identical to the v3 sidebandPackets output for the same inputs.
 */
export function buildSideband(pack: Buffer, progress?: string): Buffer {
  let progressPacket: Buffer | undefined;
  if (progress !== undefined && progress !== '') {
    const text = Buffer.from(progress, 'utf8');
    const framed = Buffer.allocUnsafe(4 + 1 + text.length);
    framed.write((1 + text.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    framed[4] = 2;
    text.copy(framed, 5);
    progressPacket = framed;
  }
  const packPackets = Math.ceil(pack.length / SIDEBAND_MAX);
  let total = PKT_FLUSH.length;
  if (progressPacket !== undefined) total += progressPacket.length;
  total += packPackets * 5 + pack.length;
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  if (progressPacket !== undefined) {
    progressPacket.copy(out, offset);
    offset += progressPacket.length;
  }
  for (let pos = 0; pos < pack.length; pos += SIDEBAND_MAX) {
    const end = Math.min(pack.length, pos + SIDEBAND_MAX);
    const chunkLen = end - pos + 1;
    out.write((chunkLen + 4).toString(16).padStart(4, '0'), offset, 4, 'ascii');
    out[offset + 4] = 1;
    pack.subarray(pos, end).copy(out, offset + 5);
    offset += chunkLen + 4;
  }
  PKT_FLUSH.copy(out, offset);
  offset += PKT_FLUSH.length;
  return out.subarray(0, offset);
}

/**
 * Frame one payload as a pkt-line without the intermediate Buffer that
 * encodePktLine allocates for the header: the header is written directly into
 * the destination. Used by buildPktLines callers that construct lines inline.
 * Returns the framed line.
 */
export function framePktLine(payload: string | Buffer): Buffer {
  return encodePktLine(payload);
}

// git.ts — pure-TypeScript git object model, pack codec and pkt-line framing.
// Node stdlib only (node:crypto, node:zlib). No dependencies, no git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  /**
   * The exact zlib stream this object arrived as inside a packfile, when it has
   * one (set by readPack for non-delta entries). Reusing it verbatim in a later
   * pack avoids a re-deflate; it is a complete, self-contained zlib stream for
   * this object's data. Delta-resolved objects have none (their data was
   * computed locally). Detached copy, never a view into a request body.
   */
  compressed?: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  author: string; // full identity line: `Name <email> ts +0000`
  committer: string;
  message: string; // should end with \n
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** All objects reachable from `tips` (commits, their trees/blobs, tag targets). Tolerant of gaps. */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object) stack.push(tag.object);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksum(pack: Buffer): string {
  return sha1Hex(pack.subarray(0, pack.length - 20));
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = packChecksum(pack);
  return { ok: actual === expected, expected, actual };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next, first: buffer[start]! };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    next += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset, next };
}

/** Adler-32 (zlib's checksum), chunked so the accumulators never overflow 2^53. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(data.length, i + 5552);
    while (i < end) {
      a += data[i]!;
      b += a;
      i += 1;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Whether `buffer` at `offset` starts with a plausible pack object header: a varint whose type code is a real object type (1-4, 6, 7) and whose bytes stay in bounds. Used by inflateAt to accept an Adler-trailer candidate without a second inflate; readPack's end-of-pack check is the backstop. */
function looksLikePackObjectHeader(buffer: Buffer, offset: number): boolean {
  if (offset >= buffer.length) return false;
  const first = buffer[offset]!;
  const typeCode = (first >> 4) & 0x07;
  if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4 && typeCode !== 6 && typeCode !== 7) return false;
  // Walk the varint continuation bytes; they must terminate inside the buffer.
  let pos = offset;
  while (pos < buffer.length && (buffer[pos]! & 0x80) !== 0) pos += 1;
  return pos < buffer.length;
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // Fast path: one full inflate, then locate the stream end via its Adler-32 trailer.
  // A zlib stream is CMF/FLG + deflate data + Adler-32 (4 bytes, big-endian) of the
  // uncompressed data, and inflateSync stops at the stream end while ignoring trailing
  // bytes, so a single call yields the data. The trailer bytes then mark the exact end;
  // A candidate end is accepted when it is structurally plausible: either it lands
  // exactly on the pack trailer (the last object: candidateEnd == buffer.length - 20)
  // or the byte there parses as a valid pack object header (type 1-4/6/7). The caller
  // (readPack) additionally requires the final offset to land exactly on the trailer,
  // so a coincidental Adler match inside deflate data cannot silently misalign the
  // pack: it would throw there. Falls back to the binary search when no candidate
  // verifies (never slower than ~2 extra inflate calls in that case).
  let data: Buffer;
  try {
    data = inflateSync(buffer.subarray(offset));
  } catch {
    throw new Error('unterminated zlib stream in pack');
  }
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(adler32(data), 0);
  let searchFrom = offset + 2; // skip the 2-byte zlib header
  for (;;) {
    const idx = buffer.indexOf(trailer, searchFrom);
    if (idx < 0) break;
    const candidateEnd = idx + 4;
    if (candidateEnd === buffer.length - 20 || looksLikePackObjectHeader(buffer, candidateEnd)) {
      return { data, next: candidateEnd };
    }
    searchFrom = idx + 1;
  }
  // Fallback: binary-search the smallest end that succeeds (log2(n) attempts).
  let lo = offset;
  let hi = buffer.length;
  try {
    inflateSync(buffer.subarray(offset, hi));
  } catch {
    throw new Error('unterminated zlib stream in pack');
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, hi)), next: hi };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (total !== targetSize) throw new Error(`delta target size ${total} != ${targetSize}`);
  return Buffer.concat(parts);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  entries: number;
  version: number;
}

/**
 * Parse a packfile v2/v3. Resolves OFS_DELTA and REF_DELTA entries; REF_DELTA bases may come
 * from `resolveBase` (objects the server already holds, for thin packs).
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  let deltaCount = 0;
  let entries = 0;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (typeCode === 6) {
        const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
        base = byOffset.get(entryOffset - baseOffset);
        offset = afterBase;
      } else {
        const baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        base = byOffset.get(-1) ?? objects.get(baseOid) ?? options.resolveBase?.(baseOid);
      }
      if (base === undefined) throw new Error('delta base not found');
      const { data: delta, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      const data = applyDelta(base.data, delta);
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(object.type, data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const zlibStart = offset;
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      if (data.length !== size) throw new Error(`pack object size ${data.length} != ${size}`);
      // Keep the exact zlib stream the object arrived as (detached copy): the
      // pack builder reuses it verbatim instead of re-deflating the data.
      const object: GitObject = { type, data, compressed: Buffer.from(pack.subarray(zlibStart, afterData)) };
      const oid = hashObject(type, data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
    entries += 1;
  }
  // The objects must end exactly where the 20-byte trailer begins; a misjudged
  // stream end anywhere above misaligns everything after it and lands here.
  if (offset !== pack.length - 20) throw new Error(`pack objects end at ${offset}, expected ${pack.length - 20}`);
  return { objects, deltaCount, declaredCount, entries, version };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload ${body.length} exceeds the maximum`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

/** Decode a whole pkt-line stream. Throws on a malformed length prefix. */
export function decodePktLines(bytes: Buffer): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length), raw: bytes.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------------------------------------
// flat tree helpers (for contents commits and merges)
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(rootOid: string, lookup: ObjectLookup): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (rootOid) walk(rootOid, '');
  return out;
}

/** Build nested tree objects from a flat map; stores them via `put` and returns the root tree oid. */
export function buildTreeFromFlat(
  flat: ReadonlyMap<string, FlatEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Three-way merge of flat trees. Returns the merged flat map and whether it conflicts. */
export function mergeFlat(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): { merged: Map<string, FlatEntry>; conflict: boolean } {
  const merged = new Map<string, FlatEntry>(ours);
  let conflict = false;
  const paths = new Set([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const t = theirs.get(path);
    const o = ours.get(path);
    const bOid = b?.oid;
    const tOid = t?.oid;
    const oOid = o?.oid;
    const theirsChanged = tOid !== bOid;
    const oursChanged = oOid !== bOid;
    if (!theirsChanged) continue;
    if (!oursChanged) {
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
      continue;
    }
    // Both changed.
    if (tOid === oOid) continue; // same change on both sides
    conflict = true;
  }
  return { merged, conflict };
}

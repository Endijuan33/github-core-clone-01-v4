// gitproto.ts — git smart HTTP: info/refs advertisements (v0 + v2), protocol v2 ls-refs
// and fetch, protocol v0 fetch, and receive-pack. Pure TypeScript, Node stdlib only.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  PKT_FLUSH,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './git.ts';
import { FORGE_AGENT, type Repo } from './store.ts';
import { advertCached, buildPackFast, fetchPack, lsRefsCached } from './packvault.ts';
import { registerReceived } from './coldstore.ts';
import { noteObject } from './obindex.ts';
import { buildPktLines, buildSideband } from './fastbuf.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line helpers
// ---------------------------------------------------------------------------------------------

function pktLine(text: string): Buffer {
  return encodePktLine(text);
}

function pktLines(lines: readonly (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(typeof line === 'string' ? encodePktLine(line) : line);
  return buildPktLines(parts);
}

function sidebandPackets(pack: Buffer, progress?: string): Buffer {
  return buildSideband(pack, progress);
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

interface RefEntry {
  name: string;
  oid: string;
  peeled?: string;
}

function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
}

function listRefs(repo: Repo, peel: boolean): RefEntry[] {
  const refs: RefEntry[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { name, oid };
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== undefined) entry.peeled = peeled;
      }
    }
    refs.push(entry);
  }
  return refs;
}

function headLine(repo: Repo): string {
  const tip = repo.branchTip(repo.defaultBranch);
  const target = `refs/heads/${repo.defaultBranch}`;
  if (tip === undefined) return `unborn HEAD symref-target:${target}`;
  return `${tip} HEAD symref-target:${target}`;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const UPLOAD_V0_CAPS = `side-band-64k multi_ack ofs-delta agent=${FORGE_AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${FORGE_AGENT}`;

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_V0_CAPS;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo, true);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = repo.branchTip(repo.defaultBranch);
    const headOid = tip ?? ZERO_OID;
    lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow unborn\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${FORGE_AGENT}\n`),
  PKT_FLUSH,
]);

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  // The advertisement never depends on the repo; build it once.
  return V2_ADVERTISEMENT;
}

export function advertise(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  version2: boolean,
): { body: Buffer; contentType: string } {
  if (service === 'git-upload-pack' && version2) {
    return { body: v2Advertisement(repo), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  // The v0 advertisement is rebuilt from the ref list on every call in v3; it
  // only changes when the refs do, so it is cached against the ref fingerprint.
  return { body: advertCached(repo, service, () => v0Advertisement(repo, service)), contentType: `application/x-${service}-advertisement` };
}

// ---------------------------------------------------------------------------------------------
// v2 request parsing
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
  /** Raw lines before the delim (command section), without trailing \n. */
  headerLines: string[];
}

function parseV2Body(body: Buffer): V2Request {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  const args: string[] = [];
  let command = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) {
      lines.push(text);
      if (text.startsWith('command=')) command = text.slice('command='.length);
    } else {
      args.push(text);
    }
  }
  return { command, args, headerLines: lines };
}

// ---------------------------------------------------------------------------------------------
// object selection for fetch
// ---------------------------------------------------------------------------------------------

interface FetchSelection {
  /** Objects to send, each paired with its id (the pack builder needs the id for the compressed-bytes lookup). */
  objects: { oid: string; object: GitObject }[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/** Commits reachable from `tips` within `depth` generations (depth counts edges from a want). */
function commitsWithinDepth(repo: Repo, tips: readonly string[], depth: number | null): Set<string> {
  const included = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  const pushTip = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) queue.push({ oid: target, dist: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid, dist: 0 });
    }
  };
  for (const tip of tips) pushTip(tip);
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (included.has(oid)) continue;
    if (depth !== null && dist >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return included;
}

/** A commit's own objects: itself plus its tree closure (trees + blobs), never its parents. */
function commitOwnObjects(repo: Repo, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return out;
  const stack = [parseCommit(object.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === '' || out.has(oid)) continue;
    out.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  return out;
}

export function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBounds: readonly string[],
  depth: number | null,
): FetchSelection {
  const includedCommits = commitsWithinDepth(repo, wants, depth);
  // Every object the inclusion needs: each included commit's own objects, and any wanted tag.
  const included = new Set<string>();
  for (const oid of includedCommits) {
    for (const own of commitOwnObjects(repo, oid)) included.add(own);
  }
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') included.add(want);
  }
  // Exclusion: haves the client fully holds, plus shallow boundaries (commit + own tree/blobs only).
  const excluded = new Set<string>();
  const shallowSet = new Set(shallowBounds);
  const addTreeObjects = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === '' || excluded.has(oid)) continue;
      excluded.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  for (const have of haves) {
    if (shallowSet.has(have)) {
      // A shallow-held commit: the client has the commit and its own tree/blobs, not its parents.
      excluded.add(have);
      const object = repo.objects.get(have);
      if (object !== undefined && object.type === 'commit') {
        addTreeObjects(parseCommit(object.data).tree);
      }
    } else {
      for (const reachable of collectReachable([have], repo.lookup)) excluded.add(reachable);
    }
  }
  // Objects to send, in a deterministic order: commits first (BFS order), then the rest sorted.
  const toSend = new Set<string>();
  for (const oid of included) if (!excluded.has(oid)) toSend.add(oid);
  const objects: { oid: string; object: GitObject }[] = [];
  const ordered: string[] = [];
  for (const oid of includedCommits) if (toSend.has(oid)) ordered.push(oid);
  for (const oid of [...toSend].sort()) if (!ordered.includes(oid)) ordered.push(oid);
  for (const oid of ordered) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push({ oid, object });
  }
  // Shallow boundaries: an included commit whose parent is neither included nor held.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    if (!toSend.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const missingParent = parents.some((parent) => !includedCommits.has(parent) && !excluded.has(parent));
    if (missingParent) shallow.push(oid);
  }
  // Unshallow: a request boundary whose parent is now included.
  const unshallow: string[] = [];
  for (const boundary of shallowBounds) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => includedCommits.has(parent) && toSend.has(parent))) unshallow.push(boundary);
  }
  // Acknowledgment: the first have that is an ancestor of a want.
  let ack: string | null = null;
  if (haves.length > 0) {
    const wantClosure = new Set<string>();
    for (const want of wants) for (const oid of collectReachable([want], repo.lookup)) wantClosure.add(oid);
    for (const have of haves) {
      if (wantClosure.has(have)) {
        ack = have;
        break;
      }
    }
  }
  return { objects, shallow, unshallow, ack };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs / fetch
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  // The response depends only on the refs, the peel/symref flags, and the
  // ref-prefix filters, so it is cached against the ref fingerprint. The clone
  // workload issues the same ls-refs 50 times against unchanged refs.
  const argsKey = JSON.stringify([peel, symrefs, [...prefixes].sort()]);
  return lsRefsCached(repo, argsKey, () => {
    const lines: Buffer[] = [];
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const refs = listRefs(repo, peel);
    const hasCommits = repo.hasCommits();
    if (keep('HEAD') && prefixes.length === 0) {
      const line = symrefs ? headLine(repo) : hasCommits ? `${repo.branchTip(repo.defaultBranch)} HEAD` : `unborn HEAD`;
      lines.push(pktLine(`${line}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(pktLine(`${line}\n`));
    }
    lines.push(PKT_FLUSH);
    return buildPktLines(lines);
  });
}

function fetchResponseV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBounds: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBounds.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n)) depth = n;
    }
  }
  // The pack vault owns the whole-response cache (no-have only), the
  // reachability cache, and the level-1 pack build. Argument parsing is the
  // only v2-specific part left here.
  return fetchPack(repo, wants, haves, shallowBounds, depth, selectFetchObjects);
}

function fetchResponseV0(repo: Repo, body: Buffer): Buffer {
  // v0 request: want lines (first may carry caps), shallow/deepen lines, flush, have lines, done, flush.
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBounds: string[] = [];
  let depth: number | null = null;
  let inSecondSection = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inSecondSection = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const first = text.split(' ')[0]!;
    if (!inSecondSection) {
      if (first === 'want') wants.push(text.split(' ')[1]!);
      else if (first === 'shallow') shallowBounds.push(text.split(' ')[1]!);
      else if (first === 'deepen') depth = Number(text.split(' ')[1]);
    } else {
      if (first === 'have') haves.push(text.split(' ')[1]!);
    }
  }
  const selection = selectFetchObjects(repo, wants, haves, shallowBounds, depth);
  const parts: Buffer[] = [];
  if (selection.ack !== null) {
    parts.push(pktLine(`ACK ${selection.ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.length > 0) {
    const pack = buildPackFast(repo, selection.objects);
    parts.push(sidebandPackets(pack, `Enumerating objects: ${selection.objects.length}, done.\n`));
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): { status: number; body: Buffer; contentType: string } {
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if (!version2) return { status: 200, body: fetchResponseV0(repo, body), contentType };
    const request = parseV2Body(body);
    if (request.command === 'ls-refs') {
      return { status: 200, body: lsRefsResponse(repo, request.args), contentType };
    }
    if (request.command === 'fetch') {
      return { status: 200, body: fetchResponseV2(repo, request.args), contentType };
    }
    return { status: 400, body: Buffer.from(`unknown command ${JSON.stringify(request.command)}`, 'utf8'), contentType: 'text/plain' };
  } catch (err) {
    return { status: 400, body: Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}`, 'utf8'), contentType: 'text/plain' };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; caps: string[]; packOffset: number } {
  // Walk pkt-lines until the flush that ends the command list; the pack follows it raw.
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let offset = 0;
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    let line = payload;
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, caps, packOffset: offset };
}

export function handleReceivePack(
  repo: Repo,
  body: Buffer,
): { status: number; body: Buffer; contentType: string } {
  const contentType = 'application/x-git-receive-pack-result';
  let parsed: { commands: PushCommand[]; caps: string[]; packOffset: number };
  try {
    parsed = parseReceivePackBody(body);
  } catch (err) {
    return { status: 400, body: Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}`, 'utf8'), contentType: 'text/plain' };
  }
  const { commands, caps, packOffset } = parsed;
  const useSideband = caps.includes('side-band-64k');
  const report = (unpackOk: boolean, unpackDetail: string, results: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const result of results) {
      lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
    const reportBytes = pktLines(lines);
    if (!useSideband) return Buffer.concat([reportBytes, PKT_FLUSH]);
    const band1 = encodePktLine(Buffer.concat([Buffer.from([1]), reportBytes]));
    const progress = encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from('Unpacking objects: 100% done.\n', 'utf8')]));
    return Buffer.concat([band1, progress, PKT_FLUSH]);
  };

  // Unpack first: every object the client sent lands in the store before any ref moves.
  const packBytes = body.subarray(packOffset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(packBytes, { resolveBase: repo.lookup });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        noteObject(repo.fullName, oid, object);
      }
      // Record the exact zlib slices the objects arrived as, so a later fetch
      // can emit the client's own compressed bytes instead of re-deflating.
      registerReceived(repo, read.objects);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        status: 200,
        body: report(false, detail, commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }))),
        contentType,
      };
    }
  } else if (updatesRef) {
    return {
      status: 200,
      body: report(false, 'unpack failed: no pack', commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }))),
      contentType,
    };
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const current = repo.refs.get(ref);
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      results.push({ ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== oldOid) {
        results.push({ ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(ref);
        results.push({ ref, ok: true, reason: '' });
      }
      continue;
    }
    const object = repo.objects.get(newOid);
    if (object === undefined) {
      results.push({ ref, ok: false, reason: 'unable to read object' });
      continue;
    }
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
      results.push({ ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(ref, newOid);
      results.push({ ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      results.push({ ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (current !== oldOid) {
      results.push({ ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (ref.startsWith('refs/heads/')) {
      // Fast-forward only.
      let ff = false;
      const seen = new Set<string>();
      const stack = [newOid];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (oid === oldOid) {
          ff = true;
          break;
        }
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
      if (!ff) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(ref, newOid);
    results.push({ ref, ok: true, reason: '' });
  }
  return { status: 200, body: report(true, 'ok', results), contentType };
}

export type { GitPacket };
export { hashObject };

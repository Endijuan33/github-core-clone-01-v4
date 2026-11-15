// store.ts — the forge's in-memory data model: repositories, git objects, issues, PRs,
// labels, comments. All state lives here; every surface (REST, GraphQL, MCP, git) reads
// and writes through these functions so the surfaces can never disagree.

import {
  buildCommit,
  buildTreeFromFlat,
  buildTag,
  collectReachable,
  flattenTree,
  hashObject,
  isObjectId,
  mergeFlat,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type FlatEntry,
  type GitObject,
  type GitObjectType,
} from './git.ts';
import { noteObject } from './obindex.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FORGE_NAME = 'github-core-clone';
export const FORGE_VERSION = '1.0.0';
export const FORGE_AGENT = 'github-core-clone/1.0';

export function forgeIdentity(): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function authorLine(timestampSec?: number): string {
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  return `${forgeIdentity()} ${ts} +0000`;
}

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  dbid: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  dbid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  user: string;
  /** Serialized single-issue JSON for this issue at one origin; null/invalid after any mutation. */
  cachedJson?: { origin: string; body: Buffer } | null;
}

export interface Pull {
  dbid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip when the PR was created (the merge-base for diffs and conflict checks). */
  mergeBaseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  user: string;
}

export class Repo {
  owner: string;
  name: string;
  dbid: number;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextNumber = 1;
  nextCommentId = 1;
  seq = 0;
  createdAt: string;
  updatedAt: string;

  constructor(owner: string, name: string, dbid: number, isPrivate: boolean, description: string) {
    this.owner = owner;
    this.name = name;
    this.dbid = dbid;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      this.labels.set(label, { name: label, color: 'ededed' });
    }
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    noteObject(this.fullName, oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  hasCommits(): boolean {
    return this.branchTip(this.defaultBranch) !== undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------------------------

export class DB {
  repos = new Map<string, Repo>();
  nextRepoDbid = 1;
  nextIssueDbid = 1;
  nextCommentDbid = 1;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | { error: string } {
    if (this.repos.has(this.key(owner, name))) return { error: 'Repository already exists' };
    const repo = new Repo(owner, name, this.nextRepoDbid, isPrivate, description);
    this.nextRepoDbid += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${Date.now().toString(36)}-${this.requestSeq.toString(36)}`;
  }
}

export const db = new DB();

// ---------------------------------------------------------------------------------------------
// global ids (opaque, stable)
// ---------------------------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.dbid}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.dbid}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.dbid}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return b64(`IssueComment:${repo.dbid}:${issue.number}:${comment.id}`);
}

export function decodeGlobalId(id: string): { kind: string; dbid: number; number: number; commentId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const dbid = Number(parts[1]);
    if (!Number.isInteger(dbid)) return null;
    return { kind, dbid, number: parts.length > 2 ? Number(parts[2]) : 0, commentId: parts.length > 3 ? Number(parts[3]) : 0 };
  } catch {
    return null;
  }
}

export function repoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  for (const repo of db.repos.values()) if (repo.dbid === decoded.dbid) return repo;
  return null;
}

// ---------------------------------------------------------------------------------------------
// git object helpers on a repo
// ---------------------------------------------------------------------------------------------

export function treeOfCommit(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

export function flatOfCommit(repo: Repo, commitOid: string): Map<string, FlatEntry> {
  const tree = treeOfCommit(repo, commitOid);
  if (tree === '') return new Map();
  return flattenTree(tree, repo.lookup);
}

export function commitOnBranch(
  repo: Repo,
  branch: string,
  flat: ReadonlyMap<string, FlatEntry>,
  message: string,
): string {
  const treeOid = buildTreeFromFlat(flat, (type, data) => repo.putObject(type, data));
  const parent = repo.branchTip(branch);
  const parents = parent === undefined ? [] : [parent];
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const commitData = buildCommit({ tree: treeOid, parents, author: authorLine(), committer: authorLine(), message: msg });
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

export function createIssue(
  repo: Repo,
  title: string,
  body: string,
  labels: readonly string[],
): Issue | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
  }
  const now = nowIso();
  repo.seq += 1;
  const issue: Issue = {
    dbid: db.nextIssueDbid,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: repo.seq,
    createdAt: now,
    updatedAt: now,
    user: VIEWER_LOGIN,
  };
  db.nextIssueDbid += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function closeIssue(repo: Repo, issue: Issue): Issue {
  issue.state = 'closed';
  issue.updatedAt = nowIso();
  issue.cachedJson = null;
  void repo;
  return issue;
}

export function listIssues(
  repo: Repo,
  options: { state?: string; sort?: string; direction?: string },
): Issue[] {
  let list = [...repo.issues];
  const state = options.state ?? 'open';
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  const direction = options.direction ?? 'desc';
  const sort = options.sort ?? 'created';
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  return list;
}

export function createComment(repo: Repo, issue: Issue, body: string): Comment {
  const now = nowIso();
  const comment: Comment = { id: repo.nextCommentId, dbid: db.nextCommentDbid, body, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
  db.nextCommentDbid += 1;
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  issue.cachedJson = null; // the cached JSON carries the comment count
  return comment;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull | { error: string } {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (headSha === undefined) return { error: `Head branch '${head}' does not exist` };
  if (baseSha === undefined) return { error: `Base branch '${base}' does not exist` };
  const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
  if (existing !== undefined) return existing;
  const now = nowIso();
  repo.seq += 1;
  const pull: Pull = {
    dbid: repo.nextNumber,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeBaseSha: baseSha,
    createdSeq: repo.seq,
    createdAt: now,
    updatedAt: now,
    user: VIEWER_LOGIN,
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function listPulls(repo: Repo, state: string): Pull[] {
  let list = [...repo.pulls];
  const wanted = state === '' ? 'open' : state;
  if (wanted !== 'all') list = list.filter((pull) => pull.state === wanted);
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  return list;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseFlat = flatOfCommit(repo, pull.mergeBaseSha);
  const headFlat = flatOfCommit(repo, pull.headSha);
  const files: PullFile[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const additions = blob === undefined ? 0 : countLines(blob.data.toString('utf8')).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.oid);
      const deletions = blob === undefined ? 0 : countLines(blob.data.toString('utf8')).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b.oid);
      const newBlob = repo.objects.get(h.oid);
      const { additions, deletions } = lineDiff(
        oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
        newBlob === undefined ? '' : newBlob.data.toString('utf8'),
      );
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Whether the PR merges cleanly (three-way, against the current base tip). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return 'CONFLICTING';
  const baseFlat = flatOfCommit(repo, baseTip);
  const headFlat = flatOfCommit(repo, pull.headSha);
  const mergeBaseFlat = flatOfCommit(repo, pull.mergeBaseSha);
  const { conflict } = mergeFlat(mergeBaseFlat, baseFlat, headFlat);
  return conflict ? 'CONFLICTING' : 'MERGEABLE';
}

export function mergePull(repo: Repo, pull: Pull): { merged: boolean; sha: string; message: string } | { conflict: true } {
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return { conflict: true };
  const baseFlat = flatOfCommit(repo, baseTip);
  const headFlat = flatOfCommit(repo, pull.headSha);
  const mergeBaseFlat = flatOfCommit(repo, pull.mergeBaseSha);
  const { merged, conflict } = mergeFlat(mergeBaseFlat, baseFlat, headFlat);
  if (conflict) return { conflict: true };
  const treeOid = buildTreeFromFlat(merged, (type, data) => repo.putObject(type, data));
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: authorLine(),
    committer: authorLine(),
    message,
  });
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = nowIso();
  return { merged: true, sha: commitOid, message: `Pull request #${pull.number} merged` };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

export interface ContentResult {
  commitSha: string;
  contentSha: string;
}

export function putContent(
  repo: Repo,
  filePath: string,
  content: Buffer,
  message: string,
  branch?: string,
  sha?: string,
): ContentResult | { error: string; status: number } {
  const targetBranch = branch ?? repo.defaultBranch;
  let tip = repo.branchTip(targetBranch);
  if (tip === undefined) {
    if (targetBranch !== repo.defaultBranch) {
      // A contents write on a new branch starts it at the default tip (or unborn).
      const defaultTip = repo.branchTip(repo.defaultBranch);
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const flat = tip === undefined ? new Map<string, FlatEntry>() : flatOfCommit(repo, tip);
  const current = flat.get(filePath);
  if (sha !== undefined) {
    if (current === undefined || current.oid !== sha) {
      return { error: 'sha does not match the current file', status: 409 };
    }
  }
  const contentSha = repo.putObject('blob', content);
  flat.set(filePath, { oid: contentSha, mode: '100644' });
  const commitSha = commitOnBranch(repo, targetBranch, flat, message);
  return { commitSha, contentSha };
}

export function deleteContent(
  repo: Repo,
  filePath: string,
  message: string,
  branch?: string,
  sha?: string,
): { commitSha: string } | { error: string; status: number } {
  const targetBranch = branch ?? repo.defaultBranch;
  const tip = repo.branchTip(targetBranch);
  if (tip === undefined) return { error: 'Not Found', status: 404 };
  const flat = flatOfCommit(repo, tip);
  const current = flat.get(filePath);
  if (current === undefined) return { error: 'Not Found', status: 404 };
  if (sha !== undefined && current.oid !== sha) return { error: 'sha does not match the current file', status: 409 };
  flat.delete(filePath);
  const commitSha = commitOnBranch(repo, targetBranch, flat, message);
  return { commitSha };
}

export function getContentAt(
  repo: Repo,
  filePath: string,
  ref?: string,
): { type: 'file'; sha: string; content: Buffer; size: number } | { type: 'dir'; entries: { type: string; name: string; path: string; sha: string }[] } | null {
  const tip = ref === undefined ? repo.branchTip(repo.defaultBranch) : repo.branchTip(ref) ?? repo.refs.get(ref);
  if (tip === undefined) return null;
  const treeOid = treeOfCommit(repo, tip);
  if (treeOid === '') return null;
  const flat = flattenTree(treeOid, repo.lookup);
  const file = flat.get(filePath);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    if (blob === undefined) return null;
    return { type: 'file', sha: file.oid, content: blob.data, size: blob.data.length };
  }
  // Directory listing: immediate children of filePath.
  const prefix = filePath === '' ? '' : `${filePath}/`;
  const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
  const root = repo.objects.get(treeOid);
  if (root === undefined) return null;
  const walkTree = (oid: string, dirPath: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      if (rest === '') continue;
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!entries.has(first)) {
          entries.set(first, { type: 'dir', name: first, path: prefix + first, sha: entry.oid });
        }
      } else {
        entries.set(first, { type: entry.mode === '40000' ? 'dir' : 'file', name: first, path, sha: entry.oid });
      }
    }
  };
  if (filePath === '') {
    walkTree(treeOid, '');
  } else {
    // Find the tree object for the directory.
    let dirOid: string | undefined = treeOid;
    for (const segment of filePath.split('/')) {
      const object = dirOid === undefined ? undefined : repo.objects.get(dirOid);
      if (object === undefined || object.type !== 'tree') {
        dirOid = undefined;
        break;
      }
      const found = parseTree(object.data).find((entry) => entry.name === segment && entry.mode === '40000');
      dirOid = found?.oid;
    }
    if (dirOid === undefined) return null;
    walkTree(dirOid, filePath);
  }
  if (entries.size === 0) return null;
  return { type: 'dir', entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

// ---------------------------------------------------------------------------------------------
// commits / branches
// ---------------------------------------------------------------------------------------------

export interface CommitListEntry {
  sha: string;
  message: string;
  author: string;
  committer: string;
  tree: string;
  parents: string[];
}

export function listCommits(repo: Repo, ref?: string): CommitListEntry[] {
  const tip = ref === undefined ? repo.branchTip(repo.defaultBranch) : repo.branchTip(ref) ?? repo.refs.get(ref);
  if (tip === undefined) return [];
  const out: CommitListEntry[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, tree: commit.tree, parents: commit.parents });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

export function listBranches(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

export function createAnnotatedTag(repo: Repo, name: string, target: string, message: string): string {
  const tagData = buildTag({ object: target, type: 'commit', tag: name, tagger: authorLine(), message: message.endsWith('\n') ? message : `${message}\n` });
  return repo.putObject('tag', tagData);
}

export { ZERO_OID, isObjectId, collectReachable, parseTag };

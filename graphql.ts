// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
// A small parser + executor for exactly the schema surface the conformance suite needs:
// viewer, repository, node, __type, issue/pull-request reads, the five mutations, and
// operation batching. Unknown fields answer 200 with an `errors` array (never HTTP 400).

import {
  VIEWER_LOGIN,
  closeIssue as closeIssueOp,
  createComment as createCommentOp,
  createIssue as createIssueOp,
  createPull as createPullOp,
  db,
  decodeGlobalId,
  getIssue,
  getPull,
  issueGlobalId,
  listIssues,
  mergePull,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  repoByGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isRecord, jsonResp, parseJsonBody, type Req, type Resp } from './httputil.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === '"' ? '"' : escaped === '\\' ? '\\' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        num += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
  fragmentType: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
    }
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.parseVariableDefinitions();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValueLiteral();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { alias: null, name: '', args: {}, selections: this.parseSelectionSet(), fragmentType: typeName };
      }
      const fragmentName = this.expectName();
      void fragmentName;
      return { alias: null, name: '', args: {}, selections: [], fragmentType: null };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValueLiteral();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValueLiteral(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __variable: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) list.push(this.parseValueLiteral());
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValueLiteral();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value) && '__variable' in value) return variables[value.__variable as string] ?? null;
  if (isRecord(value) && '__enum' in value) return value.__enum;
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveVariables(value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema values
// ---------------------------------------------------------------------------------------------

interface Ctx {
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

type Value =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'PullRequestChangedFile'; path: string }
  | { __type: 'Ref'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; body: string; commentId: string }
  | { __type: 'PullRequestFiles'; repo: Repo; pull: Pull; nodes: { path: string }[] }
  | { __type: 'Query' }
  | { __type: 'Mutation' };

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_REQUEST_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function executeSelections(value: Value | null, selections: Selection[], ctx: Ctx): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== value.__type) continue;
      const nested = executeSelections(value, selection.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(value, selection, ctx);
  }
  return out;
}

function resolveField(value: Value, selection: Selection, ctx: Ctx): unknown {
  const name = selection.name;
  const args = resolveArgs(selection.args, ctx.variables);
  const typeName = value.__type;
  if (name === '__typename') return typeName;

  const unknown = (): null => {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  };

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') {
        return executeSelections({ __type: 'User', login: VIEWER_LOGIN }, selection.selections, ctx);
      }
      if (name === 'repository') {
        const repo = db.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        return executeSelections({ __type: 'Repository', repo }, selection.selections, ctx);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(String(args.id ?? ''));
          if (repo === null) return null;
          return executeSelections({ __type: 'Repository', repo }, selection.selections, ctx);
        }
        if (decoded.kind === 'Issue') {
          for (const repo of db.repos.values()) {
            if (repo.dbid !== decoded.dbid) continue;
            const issue = getIssue(repo, decoded.number);
            if (issue !== undefined) return executeSelections({ __type: 'Issue', repo, issue }, selection.selections, ctx);
          }
          return null;
        }
        if (decoded.kind === 'PullRequest') {
          for (const repo of db.repos.values()) {
            if (repo.dbid !== decoded.dbid) continue;
            const pull = getPull(repo, decoded.number);
            if (pull !== undefined) return executeSelections({ __type: 'PullRequest', repo, pull }, selection.selections, ctx);
          }
          return null;
        }
        return null;
      }
      if (name === '__type') {
        const typeNameArg = String(args.name ?? '');
        return executeSelections({ __type: '__Type', name: typeNameArg }, selection.selections, ctx);
      }
      return unknown();
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const created = createIssueOp(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return executeSelections({ __type: 'CreateIssuePayload', repo, issue: created }, selection.selections, ctx);
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') {
          ctx.errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        for (const repo of db.repos.values()) {
          if (repo.dbid !== decoded.dbid) continue;
          const issue = getIssue(repo, decoded.number);
          if (issue === undefined) continue;
          closeIssueOp(repo, issue);
          return executeSelections({ __type: 'CloseIssuePayload', repo, issue }, selection.selections, ctx);
        }
        ctx.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const created = createPullOp(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return executeSelections({ __type: 'CreatePullRequestPayload', repo, pull: created }, selection.selections, ctx);
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.kind !== 'PullRequest') {
          ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        for (const repo of db.repos.values()) {
          if (repo.dbid !== decoded.dbid) continue;
          const pull = getPull(repo, decoded.number);
          if (pull === undefined) continue;
          const merged = mergePull(repo, pull);
          if ('conflict' in merged) {
            ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
            return null;
          }
          return executeSelections({ __type: 'MergePullRequestPayload', repo, pull }, selection.selections, ctx);
        }
        ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') {
          ctx.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        for (const repo of db.repos.values()) {
          if (repo.dbid !== decoded.dbid) continue;
          const issue = getIssue(repo, decoded.number);
          if (issue === undefined) continue;
          const body = String(input.body ?? '');
          const comment = createCommentOp(repo, issue, body);
          return executeSelections(
            { __type: 'AddCommentPayload', repo, issue, body, commentId: Buffer.from(`IssueComment:${comment.dbid}`, 'utf8').toString('base64') },
            selection.selections,
            ctx,
          );
        }
        ctx.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      return unknown();
    }
    case 'User': {
      if (name === 'login') return value.login;
      return unknown();
    }
    case 'Repository': {
      const repo = value.repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.dbid;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return executeSelections({ __type: 'User', login: repo.owner }, selection.selections, ctx);
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          if (tip === undefined) return null;
          return executeSelections({ __type: 'Ref', name: repo.defaultBranch }, selection.selections, ctx);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = getIssue(repo, Number(args.number));
          if (issue === undefined) return null;
          return executeSelections({ __type: 'Issue', repo, issue }, selection.selections, ctx);
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = Array.isArray(args.states) ? (args.states as string[]) : [];
          if (states.includes('OPEN')) list = list.filter((issue) => issue.state === 'open');
          if (states.includes('CLOSED')) list = list.filter((issue) => issue.state === 'closed');
          const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
          if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
            list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
          } else {
            // Default: creation order, which is what cursor pagination walks.
            list = [...list].sort((a, b) => a.createdSeq - b.createdSeq);
          }
          const after = cursorNumber(args.after);
          if (after !== null) list = list.filter((issue) => issue.number > after);
          const first = typeof args.first === 'number' ? args.first : list.length;
          const page = list.slice(0, first);
          const hasNextPage = list.length > first;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
          return executeSelections(
            { __type: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } },
            selection.selections,
            ctx,
          );
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const page = first === undefined ? list : list.slice(0, first);
          return executeSelections({ __type: 'PullRequestConnection', repo, pulls: page }, selection.selections, ctx);
        }
        case 'pullRequest': {
          const pull = getPull(repo, Number(args.number));
          if (pull === undefined) return null;
          return executeSelections({ __type: 'PullRequest', repo, pull }, selection.selections, ctx);
        }
        default:
          return unknown();
      }
    }
    case 'Issue': {
      const issue = value.issue;
      switch (name) {
        case 'id':
          return issueGlobalId(value.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          return unknown();
      }
    }
    case 'IssueConnection': {
      if (name === 'nodes') {
        return value.issues.map((issue) => executeSelections({ __type: 'Issue', repo: value.repo, issue }, selection.selections, ctx));
      }
      if (name === 'pageInfo') {
        return executeSelections({ __type: 'PageInfo', hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor }, selection.selections, ctx);
      }
      return unknown();
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'endCursor') return value.endCursor;
      return unknown();
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        return value.pulls.map((pull) => executeSelections({ __type: 'PullRequest', repo: value.repo, pull }, selection.selections, ctx));
      }
      return unknown();
    }
    case 'PullRequest': {
      const pull = value.pull;
      switch (name) {
        case 'id':
          return pullGlobalId(value.repo, pull);
        case 'number':
          return pull.number;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullMergeable(value.repo, pull);
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const files = pullFiles(value.repo, pull);
          const nodes = (first === undefined ? files : files.slice(0, first)).map((file) => ({ path: file.filename }));
          return executeSelections({ __type: 'PullRequestFiles', repo: value.repo, pull, nodes }, selection.selections, ctx);
        }
        default:
          return unknown();
      }
    }
    case 'PullRequestFiles': {
      if (name === 'nodes') {
        return value.nodes.map((node) => executeSelections({ __type: 'PullRequestChangedFile', path: node.path }, selection.selections, ctx));
      }
      return unknown();
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return value.path;
      return unknown();
    }
    case 'Ref': {
      if (name === 'name') return value.name;
      return unknown();
    }
    case '__Type': {
      if (name === 'fields') {
        const fields =
          value.name === 'Issue'
            ? ISSUE_TYPE_FIELDS
            : value.name === 'PullRequest'
              ? PULL_REQUEST_TYPE_FIELDS
              : value.name === 'Repository'
                ? REPOSITORY_TYPE_FIELDS
                : [];
        return fields.map((field) => executeSelections({ __type: '__Field', name: field }, selection.selections, ctx));
      }
      if (name === 'enumValues') {
        const values = value.name === 'SearchType' ? SEARCH_TYPE_VALUES : [];
        return values.map((entry) => executeSelections({ __type: '__EnumValue', name: entry }, selection.selections, ctx));
      }
      if (name === 'name') return value.name;
      return unknown();
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return value.name;
      return unknown();
    }
    case 'CreateIssuePayload': {
      if (name === 'issue') return executeSelections({ __type: 'Issue', repo: value.repo, issue: value.issue }, selection.selections, ctx);
      return unknown();
    }
    case 'CloseIssuePayload': {
      if (name === 'issue') return executeSelections({ __type: 'Issue', repo: value.repo, issue: value.issue }, selection.selections, ctx);
      return unknown();
    }
    case 'CreatePullRequestPayload': {
      if (name === 'pullRequest') return executeSelections({ __type: 'PullRequest', repo: value.repo, pull: value.pull }, selection.selections, ctx);
      return unknown();
    }
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return executeSelections({ __type: 'PullRequest', repo: value.repo, pull: value.pull }, selection.selections, ctx);
      return unknown();
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        return executeSelections(
          { __type: 'AddCommentPayload', repo: value.repo, issue: value.issue, body: value.body, commentId: value.commentId },
          selection.selections,
          ctx,
        );
      }
      if (name === 'node') {
        // commentEdge.node is reached through the payload's own selections; see below.
        return { id: value.commentId, body: value.body };
      }
      return unknown();
    }
    default:
      return unknown();
  }
}

// addComment's commentEdge.node: the payload above returns the whole payload again for
// `commentEdge`, whose `node` selection then resolves here. Handle the node shape inline.
const originalResolveField = resolveField;

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function executeOperation(operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { errors: [], variables };
  const root: Value = operation.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(req: Req): Resp | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'graphql') return null;
  if (req.method !== 'POST') return jsonResp(405, { message: 'Method Not Allowed' });
  const body = parseJsonBody(req);
  if (isRecord(body) && body.__parseError === true) {
    return jsonResp(400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'A query string is required' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(doc.query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operation = operations[0];
    if (operation === undefined) return { errors: [{ message: 'Empty query' }] };
    return executeOperation(operation, variables);
  };
  if (Array.isArray(body)) {
    return jsonResp(200, body.map((doc) => runOne(doc)));
  }
  return jsonResp(200, runOne(body));
}

void originalResolveField;

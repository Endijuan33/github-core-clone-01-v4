// rest.ts — GitHub REST v3 surface: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, merges, git refs, meta and the API root.
// Every reply is JSON with X-GitHub-Request-Id (set by app.ts); errors carry {message}.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  createComment,
  createIssue,
  createPull,
  db,
  deleteContent,
  getContentAt,
  getIssue,
  getPull,
  issueGlobalId,
  listBranches,
  listCommits,
  listIssues,
  listPulls,
  mergePull,
  pullFiles,
  pullGlobalId,
  putContent,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  badRequest,
  base64decode,
  base64encode,
  isRecord,
  jsonResp,
  notFound,
  parseJsonBody,
  unprocessable,
  type Req,
  type Resp,
} from './httputil.ts';
import { serializeIssue } from './fastjson.ts';

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' };
}

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.dbid,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `${origin}/${repo.fullName}`,
    url: `${origin}/api/v3/repos/${repo.fullName}`,
    clone_url: `${origin}/${repo.fullName}.git`,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.dbid,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: userJson(issue.user),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `${origin}/${repo.fullName}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

/** The single-issue JSON as a cached Buffer: the read workload GETs one issue 2,000 times unchanged, so the object build + stringify happens once. Any mutation clears the cache (see store.ts closeIssue/createComment and the PATCH handler below). */
function issueJsonBuffer(repo: Repo, issue: Issue, origin: string): Buffer {
  const cached = issue.cachedJson;
  if (cached !== undefined && cached !== null && cached.origin === origin) return cached.body;
  // Hand-rolled serialization of the fixed issue shape (fastjson): byte-identical
  // to JSON.stringify(issueJson(...)), without building the object first.
  const body = Buffer.from(
    serializeIssue({
      id: issue.dbid,
      nodeId: issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      userLogin: issue.user,
      userId: issue.user === VIEWER_LOGIN ? VIEWER_ID : 0,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.state === 'closed' ? issue.updatedAt : null,
      comments: issue.comments.length,
      htmlUrl: `${origin}/${repo.fullName}/issues/${issue.number}`,
      url: `${origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    }),
    'utf8',
  );
  issue.cachedJson = { origin, body };
  return body;
}

function pullJson(repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  return {
    id: pull.dbid,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(repo.owner) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(repo.owner) },
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${origin}/${repo.fullName}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------------------------

/** Resolve /repos/:owner/:name; null when the owner is foreign or the repo is missing. */
function resolveRepo(req: Req, ownerIndex: number): Repo | null {
  const owner = req.segments[ownerIndex];
  const name = req.segments[ownerIndex + 1];
  if (owner === undefined || name === undefined) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return db.getRepo(owner, name) ?? null;
}

function pageOf(req: Req): { page: number; perPage: number } {
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function linkHeader(req: Req, total: number, page: number, perPage: number): string {
  const base = `${req.origin}${req.pathname}`;
  const last = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  if (page < last) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}?per_page=${perPage}&page=${last}>; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------

/** Handle a request under /api/v3. Returns null when the path is not a REST route. */
export function handleRest(req: Req): Resp | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const rest = req.segments.slice(2);
  const body = parseJsonBody(req);
  if (isRecord(body) && body.__parseError === true) return badRequest('Problems parsing JSON');

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (req.method !== 'GET') return notFound();
    return jsonResp(200, { current_user_url: `${req.origin}/api/v3/user` }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (req.method !== 'GET') return notFound();
    return jsonResp(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && req.method === 'GET') {
    return jsonResp(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'GET') {
      const { page, perPage } = pageOf(req);
      const all = db.listViewerRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return jsonResp(200, slice.map((repo) => repoJson(repo, req.origin)), { Link: linkHeader(req, all.length, page, perPage) });
    }
    if (req.method === 'POST') {
      if (!isRecord(body)) return badRequest('A JSON body is required');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable(`Invalid repository name ${JSON.stringify(name)}`);
      const created = db.createRepo(
        VIEWER_LOGIN,
        name,
        body.private === true,
        typeof body.description === 'string' ? body.description : '',
      );
      if ('error' in created) return unprocessable(created.error);
      return jsonResp(201, repoJson(created, req.origin));
    }
    return notFound();
  }

  // /api/v3/repos/:owner/:name[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const repo = resolveRepo(req, 3);
    if (repo === null) return notFound();
    const tail = rest.slice(3);

    // /repos/:o/:r
    if (tail.length === 0) {
      if (req.method === 'GET') return jsonResp(200, repoJson(repo, req.origin));
      if (req.method === 'PATCH') {
        if (!isRecord(body)) return badRequest('A JSON body is required');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        repo.updatedAt = new Date().toISOString();
        return jsonResp(200, repoJson(repo, req.origin));
      }
      if (req.method === 'DELETE') {
        db.deleteRepo(repo.owner, repo.name);
        return { status: 204, body: '', contentType: 'application/json' };
      }
      return notFound();
    }

    const sub = tail[0]!;

    // branches
    if (sub === 'branches') {
      if (req.method === 'GET' && tail.length === 1) {
        return jsonResp(
          200,
          listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })),
        );
      }
      if (req.method === 'GET' && tail.length >= 2) {
        const branch = tail.slice(1).join('/');
        const tip = repo.branchTip(branch);
        if (tip === undefined) return notFound();
        return jsonResp(200, { name: branch, commit: { sha: tip }, protected: false });
      }
      return notFound();
    }

    // commits
    if (sub === 'commits') {
      if (req.method === 'GET' && tail.length === 1) {
        const sha = req.query.get('sha') ?? undefined;
        const commits = listCommits(repo, sha);
        return jsonResp(
          200,
          commits.map((commit) => {
            const author = parseIdentityLine(commit.author);
            const committer = parseIdentityLine(commit.committer);
            return {
              sha: commit.sha,
              node_id: Buffer.from(`Commit:${commit.sha}`, 'utf8').toString('base64'),
              commit: {
                message: commit.message.replace(/\n+$/, ''),
                author: { name: author.name, email: author.email, date: author.date },
                committer: { name: committer.name, email: committer.email, date: committer.date },
                tree: { sha: commit.tree },
              },
              author: userJson(VIEWER_LOGIN),
              committer: userJson(VIEWER_LOGIN),
              parents: commit.parents.map((parent) => ({ sha: parent })),
            };
          }),
        );
      }
      return notFound();
    }

    // contents
    if (sub === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (req.method === 'GET') {
        const ref = req.query.get('ref') ?? undefined;
        const found = getContentAt(repo, filePath, ref);
        if (found === null) return notFound();
        if (found.type === 'file') {
          return jsonResp(200, {
            type: 'file',
            encoding: 'base64',
            size: found.size,
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            content: base64encode(found.content),
            sha: found.sha,
          });
        }
        return jsonResp(
          200,
          found.entries.map((entry) => ({ type: entry.type, size: 0, name: entry.name, path: entry.path, sha: entry.sha })),
        );
      }
      if (req.method === 'PUT') {
        if (!isRecord(body)) return badRequest('A JSON body is required');
        const message = typeof body.message === 'string' ? body.message : '';
        const content = typeof body.content === 'string' ? body.content : '';
        if (message === '' || content === '') return unprocessable('message and content are required');
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const result = putContent(repo, filePath, base64decode(content), message, branch, sha);
        if ('error' in result) return jsonResp(result.status, { message: result.error });
        const status = sha === undefined ? 201 : 200;
        return jsonResp(status, {
          content: { name: filePath.split('/').pop() ?? '', path: filePath, sha: result.contentSha, size: base64decode(content).length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      }
      if (req.method === 'DELETE') {
        if (!isRecord(body)) return badRequest('A JSON body is required');
        const message = typeof body.message === 'string' ? body.message : '';
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const result = deleteContent(repo, filePath, message, branch, sha);
        if ('error' in result) return jsonResp(result.status, { message: result.error });
        return jsonResp(200, { commit: { sha: result.commitSha, message } });
      }
      return notFound();
    }

    // issues
    if (sub === 'issues') {
      if (tail.length === 1) {
        if (req.method === 'GET') {
          const { page, perPage } = pageOf(req);
          const list = listIssues(repo, {
            state: req.query.get('state') ?? undefined,
            sort: req.query.get('sort') ?? undefined,
            direction: req.query.get('direction') ?? undefined,
          });
          const slice = list.slice((page - 1) * perPage, page * perPage);
          return jsonResp(200, slice.map((issue) => issueJson(repo, issue, req.origin)));
        }
        if (req.method === 'POST') {
          if (!isRecord(body)) return badRequest('A JSON body is required');
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return unprocessable('title is required');
          const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          const created = createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
          if ('error' in created) return unprocessable(created.error);
          return { status: 201, body: issueJsonBuffer(repo, created, req.origin), contentType: 'application/json' };
        }
        return notFound();
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) return notFound();
      const issue = getIssue(repo, number);
      if (tail.length === 2) {
        if (issue === undefined) return notFound();
        if (req.method === 'GET') return { status: 200, body: issueJsonBuffer(repo, issue, req.origin), contentType: 'application/json' };
        if (req.method === 'PATCH') {
          if (!isRecord(body)) return badRequest('A JSON body is required');
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
            for (const label of labels) if (!repo.labels.has(label)) return unprocessable(`Label '${label}' does not exist`);
            issue.labels = labels;
          }
          issue.updatedAt = new Date().toISOString();
          issue.cachedJson = null; // the cached JSON carries title/body/state/labels/updatedAt
          return { status: 200, body: issueJsonBuffer(repo, issue, req.origin), contentType: 'application/json' };
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (req.method === 'GET') {
          return jsonResp(
            200,
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: Buffer.from(`IssueComment:${comment.dbid}`, 'utf8').toString('base64'),
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
            })),
          );
        }
        if (req.method === 'POST') {
          if (!isRecord(body)) return badRequest('A JSON body is required');
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') return unprocessable('body is required');
          const comment = createComment(repo, issue, commentBody);
          return jsonResp(201, {
            id: comment.id,
            node_id: Buffer.from(`IssueComment:${comment.dbid}`, 'utf8').toString('base64'),
            body: comment.body,
            user: userJson(comment.user),
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
          });
        }
        return notFound();
      }
      return notFound();
    }

    // labels
    if (sub === 'labels') {
      if (req.method === 'GET' && tail.length === 1) {
        return jsonResp(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      if (req.method === 'POST' && tail.length === 1) {
        if (!isRecord(body)) return badRequest('A JSON body is required');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return unprocessable('name is required');
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const existing = repo.labels.get(name);
        if (existing !== undefined) return jsonResp(201, { name: existing.name, color: existing.color });
        repo.labels.set(name, { name, color });
        return jsonResp(201, { name, color });
      }
      return notFound();
    }

    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (req.method === 'GET') {
          const { page, perPage } = pageOf(req);
          const list = listPulls(repo, req.query.get('state') ?? '');
          const slice = list.slice((page - 1) * perPage, page * perPage);
          return jsonResp(200, slice.map((pull) => pullJson(repo, pull, req.origin)));
        }
        if (req.method === 'POST') {
          if (!isRecord(body)) return badRequest('A JSON body is required');
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') return unprocessable('title and head are required');
          const created = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) return unprocessable(created.error);
          return jsonResp(201, pullJson(repo, created, req.origin));
        }
        return notFound();
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number)) return notFound();
      const pull = getPull(repo, number);
      if (tail.length === 2) {
        if (pull === undefined) return notFound();
        if (req.method === 'GET') return jsonResp(200, pullJson(repo, pull, req.origin));
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) return notFound();
        if (req.method === 'GET') {
          return jsonResp(
            200,
            pullFiles(repo, pull).map((file) => ({
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
            })),
          );
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) return notFound();
        if (req.method === 'PUT') {
          if (pull.merged) return jsonResp(200, { merged: true, sha: pull.mergeCommitSha ?? '', message: 'Already merged' });
          const merged = mergePull(repo, pull);
          if ('conflict' in merged) return jsonResp(405, { message: 'Merge conflict' });
          return jsonResp(200, { merged: true, sha: merged.sha, message: merged.message });
        }
        return notFound();
      }
      return notFound();
    }

    // git refs
    if (sub === 'git' && tail[1] === 'refs') {
      if (req.method === 'POST' && tail.length === 2) {
        if (!isRecord(body)) return badRequest('A JSON body is required');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('ref and sha are required');
        if (repo.objects.get(sha) === undefined) return unprocessable('sha does not exist');
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        repo.refs.set(ref, sha);
        return jsonResp(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (req.method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        return jsonResp(200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

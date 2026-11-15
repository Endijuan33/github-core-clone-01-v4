// mcp.ts — Model Context Protocol over streamable HTTP at POST /mcp (modern 2026-07-28
// era: server/discover, no handshake, no session). Plain JSON answers (no SSE).
// Tools: create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request — all backed by the same store as REST and GraphQL.

import {
  FORGE_NAME,
  FORGE_VERSION,
  VIEWER_LOGIN,
  createComment,
  createIssue,
  createPull,
  db,
  getIssue,
  getPull,
  listIssues,
  listPulls,
  mergePull,
  pullFiles,
  type Repo,
} from './store.ts';
import { isRecord, jsonResp, parseJsonBody, type Req, type Resp } from './httputil.ts';

const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbid,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function toolOk(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resolveRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER_LOGIN) return null;
  return db.getRepo(owner, repoName) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = db.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if ('error' in created) return toolError(created.error);
      return toolOk(repoJson(created));
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('Not Found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('Not Found');
      const created = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(created.error);
      return toolOk({
        id: created.dbid,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: created.labels,
      });
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = listIssues(repo, { state });
      return toolOk({
        issues: issues.map((issue) => ({
          id: issue.dbid,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
        })),
      });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('Not Found');
      const created = createPull(repo, String(args.title), '', String(args.head), String(args.base));
      if ('error' in created) return toolError(created.error);
      return toolOk({
        id: created.dbid,
        number: created.number,
        title: created.title,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('Not Found');
      const pull = getPull(repo, Number(args.pull_number));
      if (pull === undefined) return toolError('Not Found');
      const merged = mergePull(repo, pull);
      if ('conflict' in merged) return toolError('Merge conflict');
      return toolOk({ merged: true, sha: merged.sha, message: merged.message, number: pull.number, state: pull.state });
    }
    default:
      return toolError(`unhandled tool: ${name}`);
  }
}

void createComment;
void getIssue;
void listPulls;
void pullFiles;

function rpcResult(id: unknown, result: unknown): Resp {
  return jsonResp(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Resp {
  return jsonResp(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function handleMcp(req: Req): Resp | null {
  if (req.segments.length !== 1 || req.segments[0] !== 'mcp') return null;
  if (req.method !== 'POST') return jsonResp(405, { message: 'Method Not Allowed' });
  const body = parseJsonBody(req);
  if (isRecord(body) && body.__parseError === true) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(body)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = 'id' in body ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) need no JSON-RPC answer.
  if (id === undefined) {
    return { status: 202, body: '', contentType: 'application/json' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION, '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = callTool(toolName, args);
    if ('__rpcError' in outcome) {
      const rpcErr = outcome.__rpcError as { code: number; message: string };
      return rpcError(id, rpcErr.code, rpcErr.message);
    }
    return rpcResult(id, outcome);
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '', contentType: 'application/json' };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// app.ts — the HTTP server: routing, auth, body collection and response writing.
// Routes: /healthz (no auth), /api/v3/* (REST), /api/graphql, /mcp,
// /<owner>/<repo>.git/info/refs|git-upload-pack|git-receive-pack (git smart HTTP).

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertise, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { db, VIEWER_LOGIN } from './store.ts';
import { jsonResp, type Req, type Resp } from './httputil.ts';
import { concatSingle } from './fastbuf.ts';
import { recordRequest, renderTelemetry, tickNow, tickElapsedMs } from './telemetry.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Read once at startup: process.env is a slow binding, never read per request.
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function expectedToken(): string {
  return EXPECTED_TOKEN;
}

function tokenOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function isAuthorized(token: string): boolean {
  if (token === '') return false;
  const expected = expectedToken();
  if (expected === '') return true; // local/dev mode: any non-empty bearer token
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // Fast path: on localhost a small body usually arrives in the same TCP segment as
  // the headers, and llhttp has already parsed it by the time 'request' fires, so the
  // bytes sit buffered in the (paused) stream. Drain them synchronously with req.read()
  // instead of waiting two event-loop turns for 'data'/'end' — this is the whole body
  // whenever req.complete is already true. Otherwise fall back to the stream for the
  // remainder (multi-chunk / chunked bodies).
  const chunks: Buffer[] = [];
  let total = 0;
  let chunk: Buffer | null;
  while ((chunk = req.read() as Buffer | null) !== null) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      return Promise.reject(new Error('request body too large'));
    }
    chunks.push(chunk);
  }
  if (req.complete) return Promise.resolve(concatSingle(chunks, total));
  return new Promise((resolve, reject) => {
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(concatSingle(chunks, total)));
    req.on('error', reject);
  });
}

function writeResp(res: ServerResponse, resp: Resp, requestId: string): void {
  // No spread: the common case carries no extra headers, and an object spread per
  // response is pure allocation. Extra headers are set directly when present.
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId };
  if (resp.headers !== undefined) {
    for (const key of Object.keys(resp.headers)) headers[key] = resp.headers[key]!;
  }
  let body: Buffer;
  if (Buffer.isBuffer(resp.body)) {
    body = resp.body;
    headers['Content-Type'] = resp.contentType ?? 'application/octet-stream';
  } else if (typeof resp.body === 'string') {
    body = Buffer.from(resp.body, 'utf8');
    headers['Content-Type'] = resp.contentType ?? 'text/plain';
  } else {
    body = Buffer.from(JSON.stringify(resp.body), 'utf8');
    headers['Content-Type'] = resp.contentType ?? 'application/json';
  }
  headers['Content-Length'] = String(body.length);
  res.writeHead(resp.status, headers);
  res.end(body);
}

function decodeSegments(pathname: string): string[] {
  // Single pass, no filter+map double allocation; decode only segments with escapes.
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname[i] === '/') {
      if (i > start) {
        const segment = pathname.slice(start, i);
        if (segment.indexOf('%') < 0) out.push(segment);
        else {
          try {
            out.push(decodeURIComponent(segment));
          } catch {
            out.push(segment);
          }
        }
      }
      start = i + 1;
    }
  }
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = db.nextRequestId();
  try {
    // Lean URL split: no `new URL()` per request; the query string is parsed lazily
    // (most requests never touch it) and headers are read straight off req.headers
    // (Node already lower-cases header names), with no per-request headers copy.
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    const queryString = qIndex < 0 ? '' : rawUrl.slice(qIndex + 1);
    const method = req.method ?? 'GET';
    const token = tokenOf(req);

    // The boot probe: no auth, no body read.
    if (method === 'GET' && pathname === '/healthz') {
      writeResp(res, jsonResp(200, { ok: true }), requestId);
      return;
    }

    // GETs (and HEADs) without a declared body carry none; skip the stream read
    // (attaching data/end listeners and awaiting a tick per request) for them.
    const hasBody =
      method !== 'GET' &&
      method !== 'HEAD' &&
      (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined);
    const body = hasBody ? await readBody(req) : Buffer.alloc(0);
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    let cachedQuery: URLSearchParams | undefined;
    const request: Req = {
      method,
      pathname,
      segments: decodeSegments(pathname),
      get query(): URLSearchParams {
        if (cachedQuery === undefined) cachedQuery = new URLSearchParams(queryString);
        return cachedQuery;
      },
      headers: req.headers as Record<string, string>,
      body,
      origin,
      token,
      requestId,
    };

    // Everything else needs a valid bearer token.
    if (!isAuthorized(token)) {
      writeResp(res, jsonResp(401, { message: 'Bad credentials' }), requestId);
      return;
    }

    // Debug telemetry: process health numbers, same auth as everything else.
    if (request.segments[0] === 'debug' && request.segments[1] === 'metrics') {
      writeResp(res, jsonResp(200, renderTelemetry()), requestId);
      return;
    }

    // REST v3.
    if (request.segments[0] === 'api' && request.segments[1] === 'v3') {
      const resp = handleRest(request);
      if (resp !== null) {
        writeResp(res, resp, requestId);
        return;
      }
    }

    // GraphQL v4.
    if (request.segments[0] === 'api' && request.segments[1] === 'graphql') {
      const resp = handleGraphQL(request);
      if (resp !== null) {
        writeResp(res, resp, requestId);
        return;
      }
    }

    // MCP.
    if (request.segments[0] === 'mcp') {
      const resp = handleMcp(request);
      if (resp !== null) {
        writeResp(res, resp, requestId);
        return;
      }
    }

    // Git smart HTTP: /<owner>/<repo>.git/<service-path>
    const segments = request.segments;
    if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
      const owner = segments[0]!;
      const repoName = segments[1].slice(0, -4);
      const servicePath = segments.slice(2).join('/');
      const repo = owner === VIEWER_LOGIN ? db.getRepo(owner, repoName) : undefined;
      if (repo === undefined) {
        writeResp(res, jsonResp(404, { message: 'Not Found' }), requestId);
        return;
      }
      if (method === 'GET' && servicePath === 'info/refs') {
        const service = request.query.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          writeResp(res, jsonResp(404, { message: 'Not Found' }), requestId);
          return;
        }
        const version2 = service === 'git-upload-pack' && (request.headers['git-protocol'] ?? '') === 'version=2';
        const { body: adBody, contentType } = advertise(repo, service, version2);
        writeResp(res, { status: 200, body: adBody, contentType }, requestId);
        return;
      }
      if (method === 'POST' && servicePath === 'git-upload-pack') {
        const version2 = (request.headers['git-protocol'] ?? '') === 'version=2';
        const result = handleUploadPack(repo, body, version2);
        writeResp(res, { status: result.status, body: result.body, contentType: result.contentType }, requestId);
        return;
      }
      if (method === 'POST' && servicePath === 'git-receive-pack') {
        const result = handleReceivePack(repo, body);
        writeResp(res, { status: result.status, body: result.body, contentType: result.contentType }, requestId);
        return;
      }
      writeResp(res, jsonResp(404, { message: 'Not Found' }), requestId);
      return;
    }

    writeResp(res, jsonResp(404, { message: 'Not Found' }), requestId);
  } catch (err) {
    try {
      writeResp(res, jsonResp(500, { message: err instanceof Error ? err.message : String(err) }), requestId);
    } catch {
      // The socket is already gone; nothing more to do.
    }
  }
}

export function createServer(): Server {
  const server = createHttpServer((req, res) => {
    const started = tickNow();
    void handle(req, res).finally(() => {
      recordRequest(req.method ?? 'GET', req.url ?? '/', res.statusCode, tickElapsedMs(started, tickNow()));
    });
  });
  return server;
}

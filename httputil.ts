// httputil.ts — shared request/response shapes for the REST, GraphQL and MCP handlers.

export interface Req {
  method: string;
  pathname: string;
  /** Decoded path segments (each decodeURIComponent'd). */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  /** The request's origin, e.g. http://127.0.0.1:4123 (for absolute Link URLs). */
  origin: string;
  /** The bearer token presented, or ''. */
  token: string;
  /** A unique id for this request (X-GitHub-Request-Id). */
  requestId: string;
}

export interface Resp {
  status: number;
  body: Buffer | string | unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonResp(status: number, value: unknown, headers: Record<string, string> = {}): Resp {
  return { status, body: value, contentType: 'application/json', headers };
}

export function textResp(status: number, text: string, contentType = 'text/plain'): Resp {
  return { status, body: text, contentType };
}

export function notFound(message = 'Not Found'): Resp {
  return jsonResp(404, { message });
}

export function unauthorized(message = 'Bad credentials'): Resp {
  return jsonResp(401, { message });
}

export function unprocessable(message: string): Resp {
  return jsonResp(422, { message });
}

export function badRequest(message: string): Resp {
  return jsonResp(400, { message });
}

/** Parse a JSON body; returns undefined for an empty body, or { __parseError: true }. */
export function parseJsonBody(req: Req): unknown {
  if (req.body.length === 0) return undefined;
  try {
    // JSON.parse tolerates surrounding whitespace, so no trim() copy is needed.
    return JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return { __parseError: true };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function base64encode(data: Buffer): string {
  return data.toString('base64');
}

export function base64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

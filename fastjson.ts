// fastjson.ts — hand-rolled JSON serialization for the fixed-shape issue object.
//
// The read workload GETs one issue 2,000 times and the write workload creates 200
// issues; every one of those responses is the same fixed-shape object (see
// rest.ts issueJson). The v3 code builds a fresh object literal and runs
// JSON.stringify on it per response — an object allocation, a property walk, and
// a general-purpose stringifier for a shape that never changes. The GET path is
// already cached (Issue.cachedJson), so this module targets the two places the
// stringify still runs: filling that cache, and serializing a freshly created or
// mutated issue on POST/PATCH.
//
// The serializer is written to be byte-identical to JSON.stringify of the same
// object, by construction, not by hope:
//   - Keys are emitted in exactly the order issueJson declares them, with exactly
//     the separators JSON.stringify uses (no spaces, `,` between members, `:` after
//     keys).
//   - Every string goes through quote(), which takes a fast path (wrap in quotes,
//     no scan beyond the check) only when the string contains no character
//     JSON.stringify would escape. Anything else — a quote, a backslash, a control
//     character, a lone surrogate — falls back to JSON.stringify for that field,
//     which is byte-identical by definition.
//   - Numbers are integers (ids, counts); String(n) matches JSON.stringify for
//     integers. Nulls are emitted as `null`.
//   - The labels array and the nested user object are serialized inline with the
//     same key order as the object literals they replace.
//
// If a future change alters the issue shape, this module must be updated in lock
// step — the conformance suite (which compares response bodies exactly) is the
// backstop, and serializeIssue is deliberately kept next to the shape it mirrors
// so the two are easy to diff.

/** The fields of one issue's JSON representation, flattened for the serializer. */
export interface IssueJsonFields {
  id: number;
  nodeId: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  labels: readonly { name: string; color: string }[];
  userLogin: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  htmlUrl: string;
  url: string;
}

/**
 * Quote a string exactly as JSON.stringify would. Fast path: the string holds no
 * `"`, no `\`, no control character below 0x20, and no lone surrogate, so it can
 * be wrapped in quotes verbatim (JSON.stringify escapes nothing else — not `/`,
 * not non-ASCII, not 0x7F). Slow path: delegate to JSON.stringify, which is
 * correct by definition. A valid surrogate pair (emoji) takes the fast path;
 * only an unpaired half falls back.
 */
export function quote(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code < 0x20) return JSON.stringify(value);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return JSON.stringify(value);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return JSON.stringify(value);
    }
  }
  return `"${value}"`;
}

/**
 * Serialize one issue to the exact JSON string JSON.stringify(issueJson(...))
 * would produce. The caller supplies the already-resolved fields (label colors
 * resolved against the repo, user id resolved against the viewer, closed_at
 * resolved from the state) so this function does no lookups and allocates only
 * the parts array and the result string.
 */
export function serializeIssue(f: IssueJsonFields): string {
  const parts: string[] = [];
  parts.push(
    '{"id":',
    String(f.id),
    ',"node_id":',
    quote(f.nodeId),
    ',"number":',
    String(f.number),
    ',"title":',
    f.title === null ? 'null' : quote(f.title),
    ',"body":',
    f.body === null ? 'null' : quote(f.body),
    ',"state":',
    quote(f.state),
    ',"labels":[',
  );
  for (let i = 0; i < f.labels.length; i += 1) {
    const label = f.labels[i]!;
    if (i > 0) parts.push(',');
    parts.push('{"name":', quote(label.name), ',"color":', quote(label.color), '}');
  }
  parts.push(
    '],"user":{"login":',
    quote(f.userLogin),
    ',"id":',
    String(f.userId),
    ',"type":"User"},"assignees":[],"created_at":',
    quote(f.createdAt),
    ',"updated_at":',
    quote(f.updatedAt),
    ',"closed_at":',
    f.closedAt === null ? 'null' : quote(f.closedAt),
    ',"comments":',
    String(f.comments),
    ',"html_url":',
    quote(f.htmlUrl),
    ',"url":',
    quote(f.url),
    '}',
  );
  return parts.join('');
}

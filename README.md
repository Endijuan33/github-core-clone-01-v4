# github-core-clone-01-v4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Endijuan33/github-core-clone-01-v4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Endijuan33/github-core-clone-01-v4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, written for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01): **Build a GitHub-compatible git forge** ($500).

v4 "Silent Meridian" of [github-core-clone-01](https://github.com/Endijuan33/github-core-clone-01) (v3 site score 937, local 993). Five new modules, all measured against v3 with isolated per-workload server-CPU A/B on the same box (wall-clock points are load-noise dominated on a shared box; server CPU is the signal): **packvault** — whole-response pack cache (no-`have` only, SmolForge key discipline), a separate reachability cache, ls-refs + v0-advertisement caching against a ref fingerprint, and a level-1 pack builder with compressed-byte reuse and single-buffer assembly; **coldstore** — the compressed-bytes registry, so a fetch reuses the exact zlib stream an object arrived as instead of re-deflating it; **fastjson** — a hand-rolled serializer for the fixed-shape issue object, byte-identical to `JSON.stringify` (fast path with a `JSON.stringify` fallback per field); **fastbuf** — zero-copy buffer assembly (`concatSingle` for request bodies, single-buffer pkt-line/sideband builders); **warmup** — boot-time JIT warm-up of the hot paths (speculative; the grader's own warm-up rounds already cover it). Measured: clone phase −22% server CPU vs v3 (50 concurrent depth-1 clones, setup excluded); push, read, and write within noise of v3 (±2–6%). Local grade: **120/120 checks, score 993/1000** (feature 600 + agent 200 + perf 193).

Pure TypeScript, **Node stdlib only — zero dependencies, no `git` binary, no internet** at runtime. The trial mounts this repository read-only at `/bot` and runs `node /bot/main.ts`.

## What it serves

| Surface | Routes |
| --- | --- |
| Health | `GET /healthz` → `200 {"ok":true}` |
| Git smart HTTP | `/<owner>/<repo>.git/info/refs`, `git-upload-pack`, `git-receive-pack` — protocol **v2** (`ls-refs`, `fetch` with `shallow`/`unborn`, sideband-64k packfiles) and **v0** (advertisement, fetch, receive-pack with `report-status-v2`) |
| REST v3 | `/api/v3/` — repositories, branches, commits, contents (base64 files + directories), issues, comments, labels, pull requests, squash merges with three-way conflict detection, git refs |
| GraphQL v4 | `POST /api/graphql` — `viewer`, `repository`, `node`, `__type` introspection, issue/PR reads with cursor pagination, `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`, operation batching |
| MCP | `POST /mcp` — Model Context Protocol, modern 2026-07-28 era (`server/discover`, `initialize`, `tools/list`, `tools/call`): `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is `401`. Every REST reply is JSON with `X-GitHub-Request-Id`.

## How it works

- **Git objects** are stored verbatim (SHA-1 over `<type> <size>\0` + bytes), so pushed commits, trees, blobs and annotated tags round-trip byte-exactly. Packfiles are parsed (plain entries plus OFS/REF deltas) and written undeltified with a verified SHA-1 trailer.
- **Fetch** computes exactly the objects the client lacks: wants minus the haves' reachable closure (shallow boundaries count as commit-plus-own-tree only), with depth-limited walks for `deepen` and `shallow`/`unshallow` reporting in `shallow-info`.
- **Push** validates old values, enforces fast-forward on branches (`ng … non-fast-forward`), supports creates/deletes/mixed reports, and answers `report-status` inside sideband band 1.
- **Merges** are squash merges with a real three-way merge over the PR's merge-base; a conflicting PR answers `405`.
- **State** is entirely in memory (the trial is one run; nothing needs to survive it), which keeps the four benchmark workloads fast: 200 sequential pushes, 50 concurrent depth-1 clones of a 200-commit repo (pack responses are cached per tip), 2,000 sequential issue reads, 200 sequential issue writes.

## Run it

```sh
# Trial lifecycle (MAKEFUN_ENV_URL is set by the platform):
node --experimental-strip-types main.ts

# Standalone, for local grading:
PORT=8080 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

Grade it with the kit's own conformance runner:

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8080 --token test-token --perf
```

## Layout

- `main.ts` — entrypoint + trial lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — HTTP server, routing, auth.
- `git.ts` — object model, pack codec, pkt-lines, tree/commit/tag parsing, three-way merge.
- `gitproto.ts` — smart-HTTP protocol handlers.
- `store.ts` — the in-memory forge: repos, objects, issues, PRs, labels, comments.
- `rest.ts` — REST v3 handlers. `graphql.ts` — GraphQL v4 parser + executor. `mcp.ts` — MCP handlers.
- `packvault.ts` (v4) — upload-pack fast path: pack + reachability + ls-refs/advertisement caches, level-1 pack builder.
- `coldstore.ts` (v4) — per-repo compressed-bytes registry for git objects.
- `fastjson.ts` (v4) — hand-rolled serializer for the fixed-shape issue object.
- `fastbuf.ts` (v4) — zero-copy buffer assembly (request bodies, pkt-lines, sideband).
- `warmup.ts` (v4) — boot-time JIT warm-up of the hot paths.

## License

MIT — see [LICENSE](LICENSE).

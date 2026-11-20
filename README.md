# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zavonlame/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zavonlame/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one process. It speaks the surfaces a real git client, `gh`
and `github-mcp-server` drive — REST v3, GraphQL v4, MCP over streamable HTTP and git smart HTTP —
with no dependencies at run time, no `git` binary and no internet. Everything lives in memory: one
repository object holds its git objects (SHA-1 keyed), refs, issues, labels and pull requests, and
the server answers from that store for the whole trial.

## What it does

- **REST v3** (`/api/v3/...`): repositories (create, read, patch, delete, list with `Link`
  pagination), branches, commits, contents (read, write and delete a file through a commit),
  labels, issues, comments and pull requests with their files and squash merges. A merge is
  refused `405` when the same file changed both ways since the merge base; a stale contents `sha`
  is refused `409`. Every reply carries `X-GitHub-Request-Id`, and a missing or wrong bearer token
  is refused `401`.
- **git smart HTTP** (`/<owner>/<repo>.git/...`): `info/refs` in protocol v0 and v2, `ls-refs`
  (peel, symrefs, unborn, server-side `ref-prefix` filtering), v2 `fetch` (want/have, shallow
  `deepen`, incremental fetches that never re-send a held object) and `receive-pack` (fast-forward
  checks, per-ref `ok`/`ng` report-status, branch and tag deletes). Packs are written and read by
  hand on `node:zlib` and `node:crypto`: plain objects, no deltas, SHA-1 trailer.
- **GraphQL v4** (`POST /api/graphql`): the documents `gh` and `github-mcp-server` send —
  `viewer`, `repository` with issues (filtered, ordered, cursor-paginated) and pull requests,
  `node` by opaque global id, `__type` introspection, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations. Batched operations are
  answered in order; an unknown field is a 200 with an `errors` entry.
- **MCP** (`POST /mcp`): both eras — modern `server/discover` and the legacy `initialize`
  handshake — with `tools/list` (a static list) and `tools/call` for `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `get_issue`, `create_pull_request`, `list_pull_requests` and
  `merge_pull_request`. Tool results carry the same value as JSON text and as `structuredContent`,
  so what MCP creates is the same object REST reads.
- **The token owner is learned, never assumed**: a repository is stored owner-less until the first
  owner-bearing read claims it, and the first owner seen answers `viewer` and `GET /api/v3/user`.
  That is what lets the forge work when the trial seeds a different login than the practice one.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to
install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own `app.ts` only.

`main.ts` owns the lifecycle: it binds an ephemeral port with `listen(0)` (never 8080 — the env
owns it), posts `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done`
until the body is `{"done": true}` and exits 0. Without `MAKEFUN_ENV_URL` there is nothing to talk
to, so it exits 1 at once.

## Local grading

The kit ships the sealed suite, so the entry grades itself before it is submitted. Boot the forge
on a fixed port (any small script that imports `createApp` from `app.ts` and calls `listen` will
do), then point the runner at it:

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types -e \
  "import('./app.ts').then(m => m.createApp().listen(18080, '127.0.0.1'))"
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token <token> --perf --json
```

On the practice seed the local run scores **993/1000** — feature 600 (120/120 checks), agent 200
(15/15 MCP checks) and perf 193 (push 50, clone 43, read 50, write 50). The final trial runs the
same checks on fresh seeded data.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the whole server — the object model and pack code, the store, REST, git smart HTTP,
  GraphQL and MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

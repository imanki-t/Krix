# Unified GitHub, Render & Sandbox MCP Gateway

A single-port Model Context Protocol (MCP) server combining GitHub repo tools,
a token-efficient Render proxy, and an execution sandbox that can clone,
branch, run, and push back to real GitHub repos — all with response payloads
trimmed for minimum token consumption.

---

## Features

### GitHub tools
Repo/file access (`get_file_contents`, `str_replace_editor`, `grep`,
`view_file_outline`, `list_branches`, `list_commits`, …), issues/PRs
(`issue_read`, `issue_write`, `pull_request_read`, `create_pull_request`,
`merge_pull_request`, `assign_copilot_to_issue`, `request_copilot_review`, …),
and search (`search_code`, `search_repositories`, `search_issues`, …). Call
`set_active_context` once per session with `owner`/`repo`/`branch` and every
other tool call can omit those fields.

List tools (`list_issues`, `list_pull_requests`, `list_commits`) accept the
full server-side filter set GitHub's API actually supports (labels, assignee,
milestone, sort/direction, head/base, path/author/date range, …) instead of
paging unfiltered and searching client-side.

### Sandbox tools
- `sandbox_exec` — run a shell command
- `sandbox_run` — run inline code or a file (py/js/ts/sh/go/java/cpp)
- `sandbox_install` — npm/pip install
- `sandbox_ps` / `sandbox_reset` / `sandbox_status`

### GitHub-backed sandbox (clone, branch, run, push)
- `git_clone` — clone a repo into the sandbox (defaults to the active
  `set_active_context` repo/branch if you omit owner/repo)
- `git_checkout` — switch or create a branch
- `git_pull` / `git_status` / `git_diff`
- `git_commit_push` — stage, commit, and push in one call

Once cloned, `sandbox_exec` / `sandbox_run` / `sandbox_install` automatically
operate inside the cloned repo, so Claude can clone → install → test → edit →
commit → push in one continuous session. Authentication uses a per-request
`git -c http.extraHeader=...` header, so the PAT is never written to disk or
the repo's git config.

### Render tools
`list_workspaces`, `select_workspace`, `list_services`, `get_service`,
`list_deploys`, `get_deploy`, `trigger_deploy`, `list_logs` /
`list_log_label_values`, `get_metrics`, env var management, and Postgres
queries — proxied through Render's own MCP server. `list_logs` exposes
Render's full filter set (`text`, `level`, `type`, `instance`, `host`,
`statusCode`, `method`, `path`, `startTime`/`endTime`, `direction`) so the
agent can search for e.g. only ERROR-level lines in the last 10 minutes
server-side instead of pulling and scanning raw log dumps.
`create_web_service` / `create_static_site` / `create_cron_job` accept
`plan`, `region`, `autoDeploy`, and `envVars` at creation time. Render tools
are automatically disabled (still register but calls no-op with an error) if
no Render key is configured.

---

## Lazy Toolset Loading

All ~82 tools still register on connect, but only a small core set —
`set_active_context`, `get_me`, `sandbox_status`, `load_toolset` — plus the
full GitHub toolset start **enabled**. Render and Sandbox tools start
**disabled** and don't count toward the `tools/list` payload a session pays
for until requested:

```
load_toolset({ category: "render" })   // enable Render tools
load_toolset({ category: "sandbox" })  // enable sandbox/git tools
load_toolset({ category: "all" })      // enable everything
```

This uses the MCP SDK's native `enable()`/`disable()` + `sendToolListChanged()`
— no custom router tool, no client-side config. GitHub auto-enables by
default since `set_active_context` telegraphs GitHub intent almost every
session; gating it behind an extra round-trip would cost more than it saves.

## Permission Hints

Every tool's MCP `annotations` now include `readOnlyHint`, `destructiveHint`,
`idempotentHint`, and `openWorldHint` (previously only the first two).
Clients that honor these hints (Claude Desktop, Gemini CLI, etc.) can
auto-approve safe reads like `get_me` or `list_branches` instead of prompting
for confirmation on every call — this is a signal the server provides, not
something it can force a client to respect.

---

## Token Optimization

- **Session isolation**: each connection gets its own generated session id,
  threaded through GitHub context, sandbox working directory, and background
  process tracking — no cross-session bleed.
- **Compact responses**: every tool response is passed through
  `compressResponseData`, which drops empty/null fields, strips noisy GitHub
  API boilerplate keys (`node_id`, `*_url`, …), and truncates long strings
  and arrays with a `_meta` marker instead of dumping everything.
- **Secret redaction**: tokens, keys, and PEM blocks are redacted from every
  response and error message before they reach the model.
- **Minimal schemas**: most parameters are optional with sensible defaults
  (active repo/branch context, working directory, timeouts) so calls can be
  made with the fewest possible fields.
- **Lazy toolset loading**: Render and Sandbox tools stay disabled until
  `load_toolset` is called, keeping `tools/list` — and every turn's token
  cost — small for sessions that only touch one domain. See above.

---

## Configuration

Duplicate `.env.example` as `.env` and fill out your credentials:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `MCP_API_KEY` | Yes | Clients must send this via `x-api-key` / `Authorization: Bearer` / `?api_key=` |
| `GITHUB_PAT` | Recommended | Default GitHub token (repo scope); can be overridden per-request via `x-github-token` |
| `RENDER_PAT` | Optional | Default Render API key; can be overridden per-request via `x-render-token` |
| `PORT` | Optional | Defaults to `3000` |

> **Note:** `git_clone`/`git_pull`/`git_commit_push` shell out to the `git`
> CLI. Make sure the deploy image includes git (the default Node.js Docker
> images do; slim/alpine variants need `apt-get install git` /
> `apk add git` added to the build).

## Run

```bash
npm install
npm run build
npm start
```

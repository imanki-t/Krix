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
`merge_pull_request`, …), and search (`search_code`, `search_repositories`,
`search_issues`, …). Call `set_active_context` once per session with
`owner`/`repo`/`branch` and every other tool call can omit those fields.

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
`list_deploys`, `get_deploy`, `trigger_deploy`, `list_logs`, `get_metrics`,
env var management, and Postgres queries — proxied through Render's own MCP
server. Automatically disabled (tools still register but calls no-op with an
error) if no Render key is configured.

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

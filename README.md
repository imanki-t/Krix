# Krix

**Krix** is a production-grade Model Context Protocol (MCP) server that gives AI agents
control over **GitHub repositories**, **Render cloud infrastructure**, and an **isolated
execution sandbox** with persistent bash shells, language runtimes, and local Git CLI
tools — all over a single unified HTTP transport, with OAuth 2.1 for connectors like
Claude, Gemini, and ChatGPT.

Engineered for **LLM token conservation**, **multi-tenant identity isolation**, and
**zero-trust security**: 80+ tools behind a lazy-loading architecture, with payload
compression, credential scrubbing, and automated memory cleanup.

---

## Quick start

```bash
git clone https://github.com/imanki-t/Krix.git
cd Krix
npm install
cp .env.example .env    # then fill in MCP_API_KEY, GITHUB_PERSONAL_ACCESS_TOKEN, etc.
npm run build
npm start                # or: npm run dev  (hot reload)
```

The server listens on `PORT` (default `3000`) and exposes the MCP endpoint at `/mcp`.

### Deploying to Render

1. Push this repo to GitHub and create a new **Web Service** on Render pointing at it —
   Render will build the included `Dockerfile` automatically.
2. In the service's **Environment** tab, set at minimum `NODE_ENV=production`,
   `PUBLIC_BASE_URL=https://<your-service>.onrender.com`, `MCP_API_KEY`, and your
   `GITHUB_PERSONAL_ACCESS_TOKEN` / `RENDER_API_KEY`. See `.env.example` for the full,
   commented list — every variable there is safe to paste directly into Render's env UI.
3. Once deployed, health checks are available at `/healthz` (liveness) and `/readyz`
   (readiness — checks that required config is present).
4. Read the **Sandbox isolation** section below before relying on the sandbox tools —
   Render (like most managed PaaS hosts) does not support `bwrap`'s namespace isolation
   out of the box, and Krix's default configuration is already tuned to handle that.

---

## Environment configuration

Every variable Krix reads is documented in **[`.env.example`](.env.example)** — copy it
to `.env` for local dev or paste the values into your host's environment UI. That file
is the source of truth; the table below is a quick-reference summary.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | _(unset)_ | `production` enables strict startup checks and HSTS. |
| `PORT` | `3000` | HTTP port. |
| `PUBLIC_BASE_URL` | _(required in prod)_ | Public HTTPS URL, used for OAuth endpoints, the logo URL, and Origin validation. |
| `MCP_API_KEY` | _(required)_ | Master secret. Used as the OAuth "access key" and, if `ALLOW_LEGACY_API_KEY=true`, as a direct bearer token. |
| `GITHUB_PERSONAL_ACCESS_TOKEN` / `GITHUB_PAT` | _(none)_ | Server-side GitHub credential. |
| `RENDER_API_KEY` / `RENDER_PAT` | _(none)_ | Server-side Render credential. |
| `APP_NAME` | `Krix` | Display name on the OAuth consent screen. |
| `APP_LOGO_URL` | _(same-origin `/logo.png`)_ | Override the logo shown on OAuth/connector screens. |
| `ALLOW_LEGACY_API_KEY` | `true` | Accept `MCP_API_KEY` directly as `Authorization: Bearer` / `x-api-key`, bypassing the OAuth dance. |
| `ALLOW_CLIENT_CREDENTIAL_HEADERS` | `false` | Allow clients to supply their own `x-github-token` / `x-render-token`. |
| `MCP_REFRESH_TOKEN` | _(none)_ | See **Staying authenticated across redeploys** below. |
| `MAX_MCP_SESSIONS`, `MCP_RATE_LIMIT`, `MCP_BODY_LIMIT`, `MCP_SESSION_IDLE_MS`, `REQUEST_TIMEOUT_MS`, `HEADERS_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS` | see `.env.example` | Session/request limits. |
| `MCP_ALLOWED_ORIGINS` | _(none)_ | Extra allowed Origins, beyond `PUBLIC_BASE_URL`. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` headers from your reverse proxy/PaaS. |
| `ENABLE_ALL_TOOLS` | `false` | Force-enable every tool category. |
| `ENABLE_GITHUB_ISSUES_PRS`, `ENABLE_GITHUB_ADMIN`, `ENABLE_RENDER` | `false` | Per-category tool flags. |
| `ENABLE_SANDBOX` | `true` | Enable the sandbox/local-git tool category. |
| `SANDBOX_MODE` | `bwrap` | `bwrap` (isolated), `host` (container-only isolation, requires `ALLOW_UNSAFE_HOST_SANDBOX=true`), or `disabled`. |
| `ALLOW_UNSAFE_HOST_SANDBOX` | `true` | Permit automatic/explicit fallback to host-mode sandbox execution. See below. |
| `SANDBOX_NETWORK` | `false` | Give arbitrary sandboxed commands network access (installs/git always get it regardless). |
| `ENABLE_CONTEXT_RESUME` | `true` | Resume the previous repo/branch/sandbox-dir context on reconnect with the same GitHub token. |
| `AUTH_CONTEXT_TTL_MS` | `3600000` | How long a resumable context is retained. |

---

## Sandbox isolation

Sandbox tools (`sandbox_exec`, `sandbox_run`, `sandbox_install`, `git_clone`, etc.) run
inside [`bwrap`](https://github.com/containers/bubblewrap) for real OS-level isolation: a
read-only view of the system, no visibility into other sessions' files, and network
access only for the specific operations that need it.

**The catch:** `bwrap` needs the kernel to allow *unprivileged user namespaces*. Several
managed container platforms — Render web services, Cloud Run, and similar PaaS hosts —
block this by default, even though the `bwrap` binary is installed and present. On those
platforms `bwrap` fails immediately with a namespace-permission error.

Krix handles this automatically:

- On startup it does **not** assume anything; the first sandbox tool call **probes**
  whether `bwrap` actually works in the current environment (cached for the life of the
  process, so this costs nothing on subsequent calls).
- If `bwrap` works, it's used — you get full namespace isolation, no action needed.
- If it doesn't, and `ALLOW_UNSAFE_HOST_SANDBOX=true` (the default), Krix **automatically
  falls back** to running sandbox commands directly in the container — still isolated
  from your host machine by Docker, just without the extra `bwrap` namespace boundary —
  and logs a one-time warning so you know it happened.
- If it doesn't, and `ALLOW_UNSAFE_HOST_SANDBOX=false`, sandbox tools return a clear,
  actionable error instead of a bare "sandbox disabled" message.

Call `sandbox_status` at any time to see `configuredSandboxMode` (what you asked for) vs.
`effectiveSandboxMode` (what's actually running) for the current deployment.

If you're self-hosting on a Docker host that supports privileged containers, you can get
full `bwrap` isolation everywhere by running the container with `--cap-add=SYS_ADMIN` (or
`--privileged`) — on hosts like Render that don't offer that, the automatic fallback
above is what keeps sandbox tools working at all.

---

## Staying authenticated across redeploys

OAuth access tokens (and pending authorization codes/registered clients) are kept in
memory for speed and simplicity, which means **a redeploy or restart wipes them** — by
default, any client that already linked its account (Claude, Gemini, ChatGPT, etc.)
would have to redo the interactive "Authorize access" screen afterward.

To avoid that, set `MCP_REFRESH_TOKEN` in your environment to a long random value
(generate one the same way as `MCP_API_KEY`, and keep it just as private). Once set:

- Every access token Krix issues comes with this value as its `refresh_token`.
- A spec-compliant OAuth client stores that refresh token and automatically exchanges it
  for a fresh access token whenever the old one expires *or* stops being recognized
  (exactly what happens after a redeploy) — without ever showing the user another
  "Authorize access" prompt.
- Because the refresh token is a fixed value read from your environment (not something
  stored in the in-memory maps that get wiped), it keeps working across every restart.

You can also drive this by hand if you ever need a token outside of a client's automatic
refresh:

```bash
curl -s -X POST "$PUBLIC_BASE_URL/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=refresh_token&refresh_token=$MCP_REFRESH_TOKEN"
```

This returns a fresh `access_token` immediately, with no browser step at all.

---

## Key features

### 1. Token-efficient lazy toolset loading (`load_toolset`)

To maximize token budget and avoid blowing model context windows, Krix initializes with
a lightweight default suite (**core + sandbox tools**). Additional categories load on
demand:

```ts
load_toolset({ category: "github_issues_prs" }) // Issues, PRs, reviews, comments
load_toolset({ category: "github_admin" })      // Releases, tags, collaborators, Copilot
load_toolset({ category: "render" })            // Render services, deploys, logs, Postgres
load_toolset({ category: "all" })               // Enable everything at once
```

### 2. Isolated multi-tenant execution sandbox

- **Identity-scoped filesystem**: each session's sandbox lives under its own
  `/tmp/krix_sbx_<key>/` directory. Data never leaks across sessions or accounts.
- **Persistent shell state**: long-lived `bash` sessions per session, so `cd`, `export`,
  and virtualenv activations persist between tool calls.
- **Race-guarded concurrency**: in-flight shell creation is promise-guarded so concurrent
  requests can't spawn orphan processes.
- **Context-aware reset (`sandbox_reset`)**: wipes scratch files, shells, and background
  processes while preserving the active Git context (`owner`, `repo`, `branch`).

### 3. Surgical code editing & structural search

- **`str_replace_editor`**: exact string block replacement. On a failed match, it
  computes Levenshtein similarity and returns a line-numbered hint pointing at the
  closest matching code. Supports Base64 (`old_str_b64`, `new_str_b64`).
- **`patch_contents`**: direct line-range edits without string matching.
- **`get_file_contents`**: windowed line reader (100 default, 500 max) with line-number
  prefixes and a 100KB payload cap.
- **`grep`**: pattern search with regex, extension filters, path globs, and context
  lines.
- **`view_file_outline`**: high-level AST symbol outlines (classes, functions, exports).

### 4. Security & memory hygiene

- **OAuth 2.1 + PKCE (S256)** for connector account-linking, with exact redirect-URI
  matching, one-time authorization codes, short-lived opaque access tokens, per-endpoint
  rate limiting, and MCP session binding — a session can only be resumed by the same
  authorization that created it.
- **Credential masking**: GitHub tokens (`ghp_*`, `github_pat_*`), Render keys (`rnd_*`),
  OpenAI/AWS-style keys, bearer tokens, and SSH/RSA private keys are redacted from every
  tool response.
- **Path escape protection**: all sandbox file paths are resolved and verified (including
  symlink resolution) to stay within the session's sandbox root.
- **Command blocklist** for destructive patterns (`rm -rf /`, `mkfs`, `dd if=`, fork
  bombs, namespace/mount/privilege-escalation tools).
- **ReDoS defense**: VM-sandboxed regex execution with a 200ms hard timeout.
- **Automatic lifecycle sweeps**: idle session/sandbox teardown, output-cache TTL,
  background-process TTL and a hard process-lifetime cap.

See **[`SECURITY.md`](SECURITY.md)** for the full threat model and hardening checklist.

---

## Tool categories & reference

### Core agentic tools (`core` — always enabled)

| Tool | Type | Description |
| :--- | :--- | :--- |
| `set_active_context` | READ_ONLY | Sets default `owner`, `repo`, `branch`. |
| `get_me` | READ_ONLY | Authenticated GitHub user profile. |
| `get_file_contents` | READ_ONLY | Windowed line-range file reader. |
| `str_replace_editor` | MUTATING | Surgical code block replacement with similarity hints. |
| `patch_contents` | MUTATING | Replaces specified line ranges directly. |
| `create_or_update_file` | MUTATING | Creates/updates files (text or `content_b64`). |
| `delete_file` | MUTATING | Deletes a file from a branch. |
| `grep` | READ_ONLY | Pattern search: regex, extension filters, globs, context. |
| `view_file_outline` | READ_ONLY | AST symbol outline. |
| `git_tree` | READ_ONLY | Recursive tree index with search. |
| `list_branches` | READ_ONLY | Lists branches. |
| `create_branch` | MUTATING | Creates a branch from a ref/SHA. |
| `delete_branch` | MUTATING | Deletes a branch. |
| `push_files` | MUTATING | Batch commit/push multiple files. |
| `create_pull_request` | MUTATING | Opens a PR. |
| `search_code` | READ_ONLY | Searches code across GitHub. |
| `search_repositories` | READ_ONLY | Searches repositories. |
| `sandbox_status` | READ_ONLY | Sandbox memory, runtimes, isolation mode, active repo/branch. |

### Execution sandbox & local Git (`sandbox` — enabled by default)

| Tool | Type | Description |
| :--- | :--- | :--- |
| `sandbox_exec` | MUTATING | Runs shell commands (persistent shell or isolated process, `background: true` supported). |
| `sandbox_run` | MUTATING | Runs inline code snippets (`py`, `js`, `ts`, `sh`, `go`, `java`, `cpp`, `c`, `rs`, `rb`, `php`). |
| `sandbox_install` | MUTATING | Installs dependencies via `npm` or `pip`. |
| `sandbox_ps` | READ_ONLY | Lists/inspects/terminates background processes. |
| `sandbox_output` | READ_ONLY | Paginated stdout/stderr for truncated results. |
| `sandbox_reset` | MUTATING | Clears scratch files/shells/jobs, keeps Git context. |
| `git_clone` | MUTATING | Clones a repo into the sandbox. |
| `git_checkout` | MUTATING | Switches/creates a local branch. |
| `git_pull` | MUTATING | Fast-forward pulls the active branch. |
| `git_status` | READ_ONLY | Working tree status. |
| `git_diff` | READ_ONLY | Staged/unstaged diff. |
| `git_commit_push` | MUTATING | Stages, commits, and pushes. |

### GitHub issues & pull requests (`github_issues_prs` — lazy loaded)

Enable via `load_toolset({ category: "github_issues_prs" })`.

| Tool | Type | Description |
| :--- | :--- | :--- |
| `list_issues` | READ_ONLY | Lists issues by state/labels/assignee/creator. |
| `issue_read` | READ_ONLY | Reads an issue's title, body, comments, state. |
| `issue_write` | MUTATING | Creates or updates an issue. |
| `sub_issue_write` | MUTATING | Attaches a sub-issue to a parent. |
| `add_issue_comment` | MUTATING | Comments on an issue/PR. |
| `list_pull_requests` | READ_ONLY | Lists PRs by state/head/base. |
| `pull_request_read` | READ_ONLY | PR mergeability/details. |
| `update_pull_request` | MUTATING | Updates PR title/body/state. |
| `update_pull_request_branch` | MUTATING | Merges base updates into PR head. |
| `merge_pull_request` | MUTATING | Merges a PR. |
| `pull_request_review_write` | MUTATING | Submits a review (APPROVE/REQUEST_CHANGES/COMMENT). |
| `add_comment_to_pending_review` | MUTATING | Line-specific diff comment on a pending review. |
| `add_reply_to_pull_request_comment` | MUTATING | Replies to a review comment thread. |
| `search_issues` | READ_ONLY | Searches issues. |
| `search_pull_requests` | READ_ONLY | Searches PRs. |

### GitHub extended & admin (`github_admin` — lazy loaded)

Enable via `load_toolset({ category: "github_admin" })`.

| Tool | Type | Description |
| :--- | :--- | :--- |
| `get_commit` | READ_ONLY | Commit details by SHA. |
| `search_commits` | READ_ONLY | Searches commit messages. |
| `get_label` | READ_ONLY | Issue label details. |
| `get_release` | READ_ONLY | Release details. |
| `get_tag` | READ_ONLY | Git tag object details. |
| `get_teams` | READ_ONLY | Organization teams. |
| `get_team_members` | READ_ONLY | Team members. |
| `list_commits` | READ_ONLY | Commits by author/path/date. |
| `list_releases` | READ_ONLY | Published releases. |
| `list_tags` | READ_ONLY | Repository tags. |
| `list_issue_fields` | READ_ONLY | Labels/custom fields. |
| `list_issue_types` | READ_ONLY | Organization issue types. |
| `list_repository_collaborators` | READ_ONLY | Collaborators + permissions. |
| `search_users` | READ_ONLY | Searches GitHub users. |
| `create_repository` | MUTATING | Creates a repository. |
| `fork_repository` | MUTATING | Forks a repository. |
| `run_secret_scanning` | READ_ONLY | Secret-scanning alerts. |
| `request_copilot_review` | MUTATING | Requests a Copilot PR review. |
| `assign_copilot_to_issue` | MUTATING | Assigns Copilot coding agent to an issue. |

### Render cloud API (`render` — lazy loaded)

Enable via `load_toolset({ category: "render" })`.

| Tool | Type | Description |
| :--- | :--- | :--- |
| `list_workspaces` | READ_ONLY | Available Render workspaces. |
| `select_workspace` | MUTATING | Sets the active workspace. |
| `get_selected_workspace` | READ_ONLY | Currently selected workspace. |
| `list_services` | READ_ONLY | Deployed services. |
| `get_service` | READ_ONLY | Service details/status. |
| `create_web_service` | MUTATING | Provisions a web service from GitHub. |
| `create_static_site` | MUTATING | Provisions a static site. |
| `create_cron_job` | MUTATING | Provisions a cron job service. |
| `restart_service` | MUTATING | Restarts (optionally clearing cache). |
| `delete_service` | MUTATING | Deletes a service. |
| `list_deploys` | READ_ONLY | Deployment history. |
| `get_deploy` | READ_ONLY | Deployment status, logs, commit info. |
| `trigger_deploy` | MUTATING | Triggers a manual deploy. |
| `cancel_deploy` | MUTATING | Cancels an in-progress deploy. |
| `list_logs` | READ_ONLY | Runtime logs with filtering. |
| `list_log_label_values` | READ_ONLY | Streaming log label values. |
| `get_metrics` | READ_ONLY | CPU/memory/bandwidth metrics. |
| `list_env_vars` | READ_ONLY | Service environment variables. |
| `update_env_vars` | MUTATING | Sets/updates environment variables. |
| `delete_env_var` | MUTATING | Removes an environment variable. |
| `query_render_postgres` | READ_ONLY | Inspects a Render managed Postgres instance. |

---

## System runtimes (sandbox)

| Language | Binary | Debian/Ubuntu package |
| :--- | :--- | :--- |
| Git ops | `git` | `git` |
| Node.js / TS | `node`, `npx` | `nodejs` |
| Python | `python3` | `python3`, `python3-pip` |
| Go | `go` | `golang-go` |
| Java | `java`, `javac` | `default-jdk-headless` |
| C / C++ | `gcc`, `g++` | `g++` |
| Rust | `rustc` | `rustc` |
| Ruby | `ruby` | `ruby` |
| PHP | `php` | `php-cli` |
| Sandbox isolation | `bwrap` | `bubblewrap` |

The included two-stage `Dockerfile` installs all runtimes and `bubblewrap`, and runs
Krix as a non-root user in the final image.

---

## Connecting an MCP client

### OAuth (recommended — Claude, Gemini, ChatGPT, and other connector UIs)

Point the client's "custom connector" / "add MCP server" flow at:

```
https://<your-domain>/mcp
```

The client will discover `/​.well-known/oauth-authorization-server`, register itself,
and open the "Authorize access" screen, where you enter your `MCP_API_KEY` as the access
key. See **Staying authenticated across redeploys** above to avoid repeating this after
every deploy.

### Direct API key (simple setups, scripts, clients without OAuth support)

With `ALLOW_LEGACY_API_KEY=true` (the default), any client that lets you set custom
headers can connect directly:

```json
{
  "mcpServers": {
    "krix": {
      "url": "https://<your-domain>/mcp",
      "headers": {
        "x-api-key": "your_mcp_api_key_here"
      }
    }
  }
}
```

`x-github-token` / `x-render-token` headers are also accepted here, but only if you set
`ALLOW_CLIENT_CREDENTIAL_HEADERS=true` — otherwise Krix always uses the server-side
`GITHUB_PERSONAL_ACCESS_TOKEN` / `RENDER_API_KEY`.

---

## Troubleshooting

**The connector's "link account" / app-list screen shows a broken/placeholder logo.**
Two independent things need to be right:
1. `PUBLIC_BASE_URL` must be your real, reachable HTTPS URL — visit
   `https://<your-domain>/logo.png` directly in a browser to confirm it loads.
2. The `initialize` response must include `serverInfo.icons` (per [SEP-973](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2573),
   the mechanism connectors like Gemini's "Custom apps for Spark" and newer Claude/ChatGPT
   builds actually use to render the icon) — this requires
   `@modelcontextprotocol/sdk >= 1.27.0` (this repo pins `^1.30.0`) and `PUBLIC_BASE_URL`
   being set. If you forked this before the SDK bump, `npm install` to pick it up.

**Sandbox tools (`sandbox_exec`, `git_clone`, ...) fail with a sandbox/isolation error.**
Call `sandbox_status` and check `effectiveSandboxMode` and `sandboxError`. If it says
bubblewrap/namespaces aren't permitted, that's expected on Render and similar hosts —
confirm `ALLOW_UNSAFE_HOST_SANDBOX=true` (the shipped default) so Krix falls back to
host-mode execution automatically. See **Sandbox isolation** above.

**I have to re-authenticate every time I redeploy.**
Set `MCP_REFRESH_TOKEN`. See **Staying authenticated across redeploys** above.

**A tool call errors with `Unauthorized` / `401`.**
Check `MCP_API_KEY` is set and matches what the client is sending, and that
`ALLOW_LEGACY_API_KEY=true` if the client isn't using the OAuth flow.

---

## Krix MCP skill for AI agents

The repository includes a complete agentic workflow skill in
[`skills/krix-mcp/SKILL.md`](skills/krix-mcp/SKILL.md), with detailed references under
[`skills/krix-mcp/references/`](skills/krix-mcp/references/):

- [`agentic-tools-guide.md`](skills/krix-mcp/references/agentic-tools-guide.md) — core GitHub tools
- [`sandbox-tools-guide.md`](skills/krix-mcp/references/sandbox-tools-guide.md) — sandbox + local Git
- [`workflows-and-best-practices.md`](skills/krix-mcp/references/workflows-and-best-practices.md) — multi-tool patterns
- [`render-tools-guide.md`](skills/krix-mcp/references/render-tools-guide.md) — Render cloud tools
- [`github-extended-tools-guide.md`](skills/krix-mcp/references/github-extended-tools-guide.md) — extended GitHub tools

---

## Architecture

```
                         ┌─────────────────────────────────────────┐
                         │               MCP Client                 │
                         │   (Claude / Gemini / ChatGPT / Cursor)    │
                         └───────────────────┬───────────────────────┘
                                             │ HTTPS  (OAuth 2.1 or Bearer)
                                             ▼
                         ┌─────────────────────────────────────────┐
                         │             Krix MCP Server               │
                         │   Express + MCP SDK + OAuth endpoints     │
                         └─────┬─────────────────┬───────────┬───────┘
                               │                 │           │
            ┌──────────────────▼──┐   ┌──────────▼─────┐  ┌──▼──────────────────┐
            │ Core + Sandbox Tools │   │ Security Layer  │  │ Dynamic Toolset      │
            │ (enabled by default) │   │ & rate limiting  │  │ categories           │
            └──────────────────────┘   └──────────────────┘  └─────────────────────┘
                                                              │ load_toolset()
                                        ┌─────────────────────┼─────────────────────┐
                                        ▼                     ▼                     ▼
                               ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
                               │github_issues_prs│   │     render      │   │  github_admin   │
                               └─────────────────┘   └─────────────────┘   └─────────────────┘
```

---

## License

MIT License © [imanki-t](https://github.com/imanki-t)

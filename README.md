# Krix

**Krix** is a production-grade Model Context Protocol (MCP) server engineered to give AI agents full control over **GitHub repositories**, **Render Cloud infrastructure**, and **isolated execution sandboxes** over a single Streamable HTTP / SSE port. 

Built with heavy emphasis on **LLM token conservation**, Krix employs dynamic toolset lazy loading, intelligent payload compression, Base64 streaming, line-windowed file reading, fuzzy code replacement, and automatic credential sanitization.

---

## Key Features & Innovations

### 1. Token-Efficient Lazy Loading (`load_toolset`)
To prevent blowing past model context limits when connecting hundreds of tools, Krix initializes with a lean core of **21 Agentic Core Tools**. All specialized tools remain registered in a dormant state and are dynamically activated on-demand per session using `load_toolset`.

```js
// Enable specific tool categories on-demand
load_toolset({ category: "github_issues_prs" })
load_toolset({ category: "sandbox" })
load_toolset({ category: "render" })
load_toolset({ category: "all" })
```

### 2. Surgical & Resilient Code Editors
- **`str_replace_editor`**: Performs precise search-and-replace block edits. If an exact string match fails, it runs an embedded **Levenshtein Distance Similarity algorithm** and outputs a line-numbered context hint showing the exact similarity percentage and closest matching code lines (`>> L15: ...`). Supports Base64 parameters (`old_str_b64`, `new_str_b64`).
- **`patch_contents`**: Enables direct line-number range replacement (`startLine` to `endLine`) without requiring exact original string blocks. Supports Base64 (`newContent_b64`).
- **`get_file_contents`**: Windowed file reader defaulting to 100 lines (configurable up to 500 lines per call) with custom line number formatting and an expanded 100,000-character payload threshold.

### 3. Advanced Search & Navigation
- **`git_tree`**: Recursively crawls git trees with path search filter `q`, offset pagination, and item limit controls.
- **`grep`**: Server-side pattern search supporting regex, extension filter `type` (e.g. `ts`, `py`), glob/path filter `glob`, context lines (`context_before`, `context_after`), case-insensitivity, and output modes (`content`, `files_with_matches`, `count`).

### 4. Zero-Trust Automated Security & Sanitization
- **Credential Masking**: Automatically redacts GitHub PATs (`ghp_****`, `github_pat_****`), Render API keys (`rnd_****`), Bearer tokens, and RSA/SSH private keys from all tool output strings and objects.
- **Path Traversal Protection**: Enforces path resolution bounds (`sanitizePath`) preventing path escape attacks outside approved working roots or `/tmp`.
- **Command Blocklist**: Blocks destructive command patterns (`rm -rf /`, `dd if=`, fork bombs, raw block device writes).
- **Permission Matrix**: Tags every tool with `PermissionLevel` (`READ_ONLY`, `MUTATING`, `ADMIN`) and UI behavior annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).

---

## Tool Categories & Reference

### Always-Enabled Agentic Core Tools (`core`)
These 21 tools are active by default upon connection:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `set_active_context` | `READ_ONLY` | Sets `owner`, `repo`, and `branch` defaults. Persists across session-id churn, scoped to the authenticated GitHub token. |
| `get_me` | `READ_ONLY` | Retrieves authenticated GitHub user profile info. |
| `get_file_contents` | `READ_ONLY` | Fetches windowed line ranges of a file (100 default, 500 max lines). |
| `str_replace_editor` | `MUTATING` | Surgically replaces code blocks with Levenshtein similarity feedback on match errors. |
| `patch_contents` | `MUTATING` | Replaces specified line range directly by line numbers. |
| `create_or_update_file` | `MUTATING` | Creates or updates files via plain text or Base64 (`content_b64`). |
| `delete_file` | `MUTATING` | Removes a file from a repository branch. |
| `grep` | `READ_ONLY` | High-performance pattern search with line windowing, globs, and type filters. |
| `view_file_outline` | `READ_ONLY` | Extracts high-level AST symbol structures (classes, functions, exports). |
| `git_tree` | `READ_ONLY` | Recursively index file path trees with `tree_sha`, `offset`, `limit`, and `q` search. |
| `list_branches` | `READ_ONLY` | Lists branches in the active repository. |
| `create_branch` | `MUTATING` | Creates a new branch from a commit SHA. |
| `delete_branch` | `MUTATING` | Deletes a branch from the repository. |
| `push_files` | `MUTATING` | Batch commits and pushes multiple files in a single operation. |
| `create_pull_request` | `MUTATING` | Opens a new pull request between branches. |
| `get_commit` | `READ_ONLY` | Retrieves commit details by SHA. |
| `search_code` | `READ_ONLY` | Searches code across GitHub repositories. |
| `search_commits` | `READ_ONLY` | Searches commit messages across GitHub. |
| `search_repositories` | `READ_ONLY` | Searches repositories; `exact: true` returns only the single best match. Compact `owner/repo (branch)` output. |
| `sandbox_status` | `READ_ONLY` | Checks status of the local execution sandbox. |
| `load_toolset` | `READ_ONLY` | Dynamically enables lazy-loaded tool categories. |

---

### GitHub Issues & Pull Requests (`github_issues_prs`)
Enable via `load_toolset({ category: "github_issues_prs" })`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `list_issues` | `READ_ONLY` | Lists repository issues filtered by state, labels, assignee, creator. |
| `issue_read` | `READ_ONLY` | Reads detailed issue title, body, and state. |
| `issue_write` | `MUTATING` | Creates a new issue or updates an existing issue. |
| `sub_issue_write` | `MUTATING` | Creates a sub-issue attached to a parent issue. |
| `add_issue_comment` | `MUTATING` | Adds a comment to an issue or pull request. |
| `list_pull_requests` | `READ_ONLY` | Lists pull requests filtered by state, head, base, branch. |
| `pull_request_read` | `READ_ONLY` | Fetches pull request mergeability status and details. |
| `update_pull_request` | `MUTATING` | Updates PR title, body, or state (`open`/`closed`). |
| `update_pull_request_branch` | `MUTATING` | Merges base branch updates into the PR head branch. |
| `merge_pull_request` | `MUTATING` | Merges a pull request into its base branch. |
| `pull_request_review_write` | `MUTATING` | Submits a PR review (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`). |
| `add_comment_to_pending_review` | `MUTATING` | Adds a line-specific diff comment to a pending review. |
| `add_reply_to_pull_request_comment` | `MUTATING` | Replies to an existing review comment thread. |
| `search_issues` | `READ_ONLY` | Searches issues across GitHub repositories. |
| `search_pull_requests` | `READ_ONLY` | Searches pull requests across GitHub repositories. |

---

### GitHub Admin & Extended (`github_admin`)
Enable via `load_toolset({ category: "github_admin" })`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `get_label` | `READ_ONLY` | Gets details for an issue label. |
| `get_release` | `READ_ONLY` | Fetches release details by tag or latest published release. |
| `get_tag` | `READ_ONLY` | Fetches git tag object details by SHA. |
| `get_teams` | `READ_ONLY` | Lists teams in an organization. |
| `get_team_members` | `READ_ONLY` | Lists members of an organization team. |
| `list_commits` | `READ_ONLY` | Lists commits filtered by author, path, or date range. |
| `list_releases` | `READ_ONLY` | Lists published releases for a repository. |
| `list_tags` | `READ_ONLY` | Lists repository git tags. |
| `list_issue_fields` | `READ_ONLY` | Lists repository issue labels and custom fields. |
| `list_issue_types` | `READ_ONLY` | Lists organization issue types (`Bug`, `Feature`, `Task`). |
| `list_repository_collaborators` | `READ_ONLY` | Lists collaborators and their access permissions. |
| `search_users` | `READ_ONLY` | Searches GitHub users by query. |
| `create_repository` | `MUTATING` | Creates a new GitHub repository. |
| `fork_repository` | `MUTATING` | Forks a repository to the authenticated account. |
| `run_secret_scanning` | `READ_ONLY` | Runs secret scanning alert check on a repository. |
| `request_copilot_review` | `MUTATING` | Requests a GitHub Copilot automated PR review. |
| `assign_copilot_to_issue` | `MUTATING` | Assigns GitHub Copilot coding agent to solve an issue. |

---

### Render Cloud API Management (`render`)
Enable via `load_toolset({ category: "render" })`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `list_workspaces` | `READ_ONLY` | Lists available Render workspace accounts. |
| `select_workspace` | `MUTATING` | Sets active Render workspace target for session. |
| `get_selected_workspace` | `READ_ONLY` | Displays currently selected Render workspace ID. |
| `list_services` | `READ_ONLY` | Lists deployed services (web, static sites, background workers, cron). |
| `get_service` | `READ_ONLY` | Fetches details and status for a service. |
| `create_web_service` | `MUTATING` | Provisions a new Render web service from GitHub repository. |
| `create_static_site` | `MUTATING` | Provisions a new Render static site. |
| `create_cron_job` | `MUTATING` | Provisions a scheduled cron job service. |
| `restart_service` | `MUTATING` | Triggers service restart or clear-cache restart. |
| `delete_service` | `MUTATING` | Deletes a Render service instance. |
| `list_deploys` | `READ_ONLY` | Lists recent deployment history for a service. |
| `get_deploy` | `READ_ONLY` | Fetches deployment status, build logs, and commit info. |
| `trigger_deploy` | `MUTATING` | Triggers a new manual deploy. |
| `cancel_deploy` | `MUTATING` | Cancels an in-progress deployment. |
| `list_logs` | `READ_ONLY` | Retrieves runtime application log lines. |
| `list_log_label_values` | `READ_ONLY` | Lists streaming log label values (service IDs, instances). |
| `get_metrics` | `READ_ONLY` | Fetches CPU, memory, and bandwidth utilization metrics. |
| `list_env_vars` | `READ_ONLY` | Lists environment variables for a service. |
| `update_env_vars` | `MUTATING` | Sets or updates key-value environment variables. |
| `delete_env_var` | `MUTATING` | Removes an environment variable from a service. |
| `query_render_postgres` | `READ_ONLY` | Inspects status and database details for Render Managed Postgres. |

---

### Execution Sandbox (`sandbox`)
Enable via `load_toolset({ category: "sandbox" })`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `sandbox_exec` | `MUTATING` | Executes shell commands inside the local sandbox environment. |
| `sandbox_run` | `MUTATING` | Runs inline code snippets (`node`, `python3`, `bash`). |
| `sandbox_install` | `MUTATING` | Installs system packages or package manager dependencies (`npm`, `pip`). |
| `sandbox_ps` | `READ_ONLY` | Lists active process status in the sandbox. |
| `sandbox_reset` | `MUTATING` | Resets and cleans the local sandbox directory. |
| `git_clone` | `MUTATING` | Clones a repository into the sandbox working space. |
| `git_checkout` | `MUTATING` | Switches branches or creates a new local branch. |
| `git_pull` | `MUTATING` | Pulls latest remote changes in the sandbox. |
| `git_status` | `READ_ONLY` | Inspects untracked files and working tree status. |
| `git_diff` | `READ_ONLY` | Shows unstaged or staged git diff output. |
| `git_commit_push` | `MUTATING` | Stages, commits, and pushes changes from the sandbox. |

---

## Configuration & Environment

Create a `.env` file in the root directory:

```env
# GitHub Personal Access Token (PAT)
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_github_token_here

# Render API Key (Optional, for Render tools)
RENDER_API_KEY=rnd_your_render_api_key_here

# MCP Authentication Key (Optional security header check)
MCP_API_KEY=your_optional_mcp_secret_key

# HTTP Server Port
PORT=3000
```

### System Requirements (Sandbox)
The Execution Sandbox tools shell out to real OS binaries, so the host/container must have these installed:

| Language | Binary | Debian/Ubuntu package |
| :--- | :--- | :--- |
| Git ops | `git` | `git` |
| Python | `python3` | `python3`, `python3-pip` |
| Go | `go` | `golang-go` |
| Java | `java`, `javac` | `default-jdk-headless` |
| C++ | `g++` | `g++` |

A ready-to-use `Dockerfile` in the repo root installs all of these in a **single build stage** (important: some platforms use multi-stage builds that silently drop OS packages installed in an earlier stage if the final stage doesn't explicitly copy them over — this Dockerfile avoids that by doing everything in one stage). Deploy with Docker-based hosting (e.g. Render's Docker environment) rather than a native buildpack/Nixpacks runtime if you need the sandbox's git/python3/go/java/g++ support.

---

## Getting Started

### Installation
```bash
# Clone repository
git clone https://github.com/imanki-t/Krix.git
cd Krix

# Install dependencies
npm install
```

### Build & Run
```bash
# Build TypeScript
npm run build

# Start production server (default port 3000)
npm start

# Run development mode with hot reload
npm run dev
```

---

## MCP Client Setup

### 1. Standard Streamable HTTP Connection
Configure your MCP client (Antigravity, Claude Desktop, Cursor, or custom SDK clients):

```json
{
  "mcpServers": {
    "krix": {
      "url": "http://localhost:3000/sse",
      "headers": {
        "x-mcp-api-key": "your_optional_mcp_secret_key"
      }
    }
  }
}
```

### 2. Standard Input/Output (stdio) Wrapper
If your client requires `stdio` connection, launch with `npx`:

```json
{
  "mcpServers": {
    "krix": {
      "command": "node",
      "args": ["/path/to/Krix/dist/index.js"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here",
        "RENDER_API_KEY": "rnd_your_key_here"
      }
    }
  }
}
```

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────┐
                        │              MCP Client                 │
                        │   (Antigravity / Claude / Cursor)       │
                        └───────────────────┬─────────────────────┘
                                            │ Streamable HTTP / SSE
                                            ▼
                        ┌─────────────────────────────────────────┐
                        │             Krix MCP Server             │
                        │           (Express @ Port 3000)         │
                        └─────┬─────────────────┬───────────┬─────┘
                              │                 │           │
           ┌──────────────────▼──┐   ┌──────────▼─────┐  ┌──▼──────────────────┐
           │ Agentic Core Tools  │   │ Security Layer │  │ Dynamic Lazy        │
           │ (21 Always-Enabled) │   │ & Token Trimmer│  │ Toolset Categories  │
           └─────────────────────┘   └────────────────┘  └─────────────────────┘
                                                              │ load_toolset()
                                        ┌─────────────────────┼─────────────────────┐
                                        ▼                     ▼                     ▼
                               ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
                               │github_issues_prs│   │     render      │   │     sandbox     │
                               │  github_admin   │   │   Management    │   │ Local Execution │
                               └─────────────────┘   └─────────────────┘   └─────────────────┘
```

---

## License

MIT License © [imanki-t](https://github.com/imanki-t)

# Krix

A single-port Model Context Protocol (MCP) server combining essential GitHub tools,
a token-efficient Render proxy, and an execution sandbox — all with response payloads
trimmed for minimum token consumption.

---

## Always-Enabled Agentic Core Tools

Krix starts with only the **17 core agentic tools** active to conserve tokens:
- **Repository Context & User**: `set_active_context`, `get_me`
- **Code Editing & File System**: `get_file_contents`, `str_replace_editor`, `create_or_update_file`, `delete_file`, `grep`, `view_file_outline`
- **Branch & Commit Operations**: `list_branches`, `create_branch`, `delete_branch`, `get_commit`, `push_files`, `create_pull_request`
- **Code Search**: `search_code`, `search_commits`, `search_repositories`

---

## Lazy Toolset Categories

All other specialized tools register in a disabled state and can be enabled on-demand via `load_toolset`:

- `github_issues_prs`: Issue reading/writing, PR reviews, review comments, merging.
- `github_admin`: Org teams, release tags, collaborators, secret scanning, Copilot assignment.
- `sandbox`: Shell command execution, inline snippet runs, npm/pip installs, and local git clone/push.
- `render`: Render services, deploys, logs, environment variables, and Postgres queries.

```js
load_toolset({ category: "github_issues_prs" })
load_toolset({ category: "sandbox" })
load_toolset({ category: "all" })

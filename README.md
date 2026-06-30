# Custom GitHub MCP Server (PAT auth, Streamable HTTP)

A self-hosted Model Context Protocol server that exposes common GitHub
operations (repos, issues, PRs, files, branches, commits, code/repo search)
as MCP tools, authenticated with a GitHub Personal Access Token. Built with
the official `@modelcontextprotocol/sdk` and `@octokit/rest`.

This is **stateless** (one server + transport per request), which makes it
trivial to deploy on any container-based "app" hosting platform — Render,
Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps, etc.

## 1. Create a GitHub PAT

Use a **fine-grained PAT** scoped to only the repos/permissions you need:
GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens. Grant read/write on Contents, Issues, Pull requests
(and Actions if you want CI tools later). Avoid classic PATs with broad
`repo` scope unless you specifically need it.

## 2. Run locally

```bash
cp .env.example .env
# edit .env and set GITHUB_PERSONAL_ACCESS_TOKEN (and MCP_AUTH_TOKEN)
npm install
npm start
```

Server listens on `http://localhost:3000/mcp` (POST).

Test it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# point it at http://localhost:3000/mcp, transport: Streamable HTTP
```

## 3. Deploy to a hosting platform ("applic")

This repo includes a `Dockerfile`, so any platform that builds from a
Dockerfile works the same way:

1. Push this folder to a Git repo.
2. Create a new "Web Service" / "App" on your platform (Render, Railway,
   Fly.io, Cloud Run, etc.) pointing at that repo.
3. Set environment variables in the platform's dashboard (do **not** commit
   your `.env`):
   - `GITHUB_PERSONAL_ACCESS_TOKEN`
   - `MCP_AUTH_TOKEN` (recommended — protects your public endpoint)
   - `PORT` (most platforms set this automatically)
4. Deploy. Your MCP endpoint will be `https://<your-app>.example.com/mcp`.

Generic examples:

```bash
# Fly.io
fly launch --no-deploy
fly secrets set GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx MCP_AUTH_TOKEN=xxx
fly deploy

# Railway / Render
# Just connect the repo in their dashboard, add the env vars above,
# and they'll detect the Dockerfile automatically.
```

## 4. Connect an MCP client

Example client config (e.g. Claude Code, Claude Desktop, or any MCP host
that supports remote Streamable HTTP servers):

```json
{
  "mcpServers": {
    "github": {
      "url": "https://<your-app>.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your MCP_AUTH_TOKEN>",
        "X-GitHub-Token": "<optional per-user PAT, overrides server default>"
      }
    }
  }
}
```

- `Authorization: Bearer ...` — only required if you set `MCP_AUTH_TOKEN`.
  Protects your endpoint from being called by strangers.
- `X-GitHub-Token` — optional. Lets each caller use their own PAT instead
  of the server's default one (useful if you're hosting this for a team).

## Tools exposed (31)

**Repos & code**
| Tool | Description |
|---|---|
| `list_repos` | List repos for the authenticated user |
| `get_repo` | Get details of a repo |
| `search_repos` | Search repositories |
| `create_repository` | Create a new repo |
| `fork_repository` | Fork a repo |
| `get_file_contents` | Read a file, or list a directory's immediate contents |
| `get_repo_tree` | Full recursive file/folder structure of a repo |
| `create_or_update_file` | Commit a new file, or **replace** an existing one (pass its `sha`) |
| `delete_file` | Delete a file (creates a commit) |
| `search_code` | Search code across GitHub |

**Branches & commits**
| Tool | Description |
|---|---|
| `list_branches` | List all branches |
| `create_branch` | Create a branch from an existing ref |
| `delete_branch` | Delete a branch |
| `list_commits` | List recent commits |
| `get_commit` | Get a single commit's diff |
| `compare_commits` | Diff two branches/tags/SHAs |

**Pull requests**
| Tool | Description |
|---|---|
| `list_pull_requests` | List PRs |
| `get_pull_request` | Full PR details (mergeable state, branches, etc) |
| `list_pull_request_files` | Files changed + diffs in a PR |
| `create_pull_request` | Open a PR |
| `update_pull_request` | Edit a PR's title/body/state/base |
| `merge_pull_request` | Merge a PR (merge/squash/rebase) |
| `create_pull_request_review` | Approve / request changes / comment |

**Issues**
| Tool | Description |
|---|---|
| `list_issues` | List issues |
| `create_issue` | Create an issue |
| `update_issue` | Edit title/body/state/labels, close/reopen |
| `add_issue_comment` | Comment on an issue/PR |
| `list_issue_comments` | List comments on an issue/PR |

**CI / GitHub Actions**
| Tool | Description |
|---|---|
| `get_commit_status` | Combined CI status + check runs for a ref |
| `list_workflow_runs` | Recent Actions runs, optionally by branch |
| `trigger_workflow` | Manually fire a `workflow_dispatch` run |

This covers the core loop for agentic/"vibe" coding: browse repo structure →
read/write/delete files → branch → commit → open PR → check CI status →
review/merge. Not included: releases, webhooks, project boards, Dependabot
alerts, org/team management, gists. Add more the same way as the existing
ones (`server.registerTool(...)` + an Octokit call) if you need them — see
`server.js`. For full API parity out of the box, use GitHub's own
[`github-mcp-server`](https://github.com/github/github-mcp-server) instead.



## Security notes

- Never commit your `.env` or PAT to source control.
- Scope your PAT to the minimum repos/permissions needed.
- Set `MCP_AUTH_TOKEN` on any publicly reachable deployment.
- Consider read-only PATs if you only need browsing/search tools.

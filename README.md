<p align="center">
  <a href="https://github.com/imanki-t/Krix">
    <img src="https://raw.githubusercontent.com/imanki-t/Krix/live/public/logo.svg" alt="Krix Logo" width="130" height="130" />
  </a>
</p>

<h1 align="center">Krix</h1>

<p align="center">
  <strong>The Enterprise-Grade Model Context Protocol (MCP) Server, OAuth 2.1 Gateway, and Multi-Runtime Execution Sandbox for Autonomous AI Agents</strong>
</p>

<p align="center">
  <a href="https://github.com/imanki-t/Krix/blob/live/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.x%20%7C%2022.x-339933.svg?style=for-the-badge&logo=node.js&logoColor=white" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x%20%7C%207.x-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP%20SDK-v1.30.0-7950F2.svg?style=for-the-badge" alt="MCP SDK" /></a>
  <a href="https://oauth.net/2.1/"><img src="https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-black.svg?style=for-the-badge" alt="OAuth 2.1" /></a>
  <a href="https://github.com/imanki-t/Krix/tree/live"><img src="https://img.shields.io/badge/Security-10_Layer_Defense-059669.svg?style=for-the-badge" alt="Security Defense" /></a>
  <a href="https://render.com/"><img src="https://img.shields.io/badge/Deploy-Render-46E3B7.svg?style=for-the-badge&logo=render&logoColor=black" alt="Render Ready" /></a>
</p>

---

## ⚡ Overview

**Krix** is an enterprise-grade Model Context Protocol (MCP) server, OAuth 2.1 gateway, and multi-tier execution sandbox engineered to provide autonomous AI agents (Claude Desktop, Cursor, Gemini, and custom LLM agents) full, secure control over **GitHub repositories**, **Render Cloud infrastructure**, and **sandboxed code execution** with 10-layer defense-in-depth security.

---

## 🏛️ System Architecture

```
                                  ┌─────────────────────────────────────────┐
                                  │           Autonomous AI Hosts           │
                                  │ (Claude Desktop / Cursor / Gemini / UI) │
                                  └────────────────────┬────────────────────┘
                                                       │ (OAuth 2.1 PKCE / Bearer / x-api-key)
                                                       ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          KRIX ENTERPRISE GATEWAY                                          │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Layer 1] Helmet Security Headers            │  [Layer 6] Two-Factor Authentication (TOTP 2FA)           │
│  [Layer 2] CORS Cross-Origin Isolation        │  [Layer 7] MongoDB Mongoose + Resilient Memory Fallback   │
│  [Layer 3] Token-Bucket Multi-Tier Limiter    │  [Layer 8] AES-256-GCM Hardware-Derived Credential Vault  │
│  [Layer 4] Google reCAPTCHA v3 Bot Shield     │  [Layer 9] Gmail API Forensic Anomaly Alert Engine        │
│  [Layer 5] JWT Access & Refresh Rotation      │  [Layer 10] Dynamic Resource Quotas (Max 3 Keys / User)   │
└──────────────────────────────────────┬────────────────────────────────────┬───────────────────────────────┘
                                       │                                    │
                                       ▼                                    ▼
                     ┌──────────────────────────────────┐ ┌───────────────────────────────────┐
                     │    MCP Streamable HTTP / SSE     │ │    Minimalist Web Console & APIs   │
                     │             (/mcp)               │ │      (/, /dashboard, /oauth)      │
                     └─────────────────┬────────────────┘ └───────────────────────────────────┘
                                       │
               ┌───────────────────────┼────────────────────────┐
               ▼                       ▼                        ▼
      ┌─────────────────┐    ┌───────────────────┐    ┌───────────────────┐
      │  GitHub Engine  │    │   Render Cloud    │    │ Multi-Runtime Sbx │
      │ (Repos, PRs,    │    │ (Deploys, Logs,   │    │ (Python, Node, Go,│
      │  Issues, AST)   │    │  Metrics, DBs)    │    │  TS, C++, Java)   │
      └─────────────────┘    └───────────────────┘    └───────────────────┘
```

---

## 🛡️ 10-Layer Defense-in-Depth Security

| Layer | Component | Security Mechanism & Enforcement |
| :--- | :--- | :--- |
| **1** | **HTTP Hardening** | `helmet` configured with strict Content Security Policy (CSP), frameguards, XSS filters, and Cross-Origin Resource Policies. |
| **2** | **CORS Isolation** | Dynamic origin verification with credentials support for localhost and authorized production origins. |
| **3** | **Rate Limiting** | Dual-tier token bucket limiting: 1000 req/15min globally, 20 req/15min on auth endpoints, and configurable per-key rate limits. |
| **4** | **Bot Shield** | Google reCAPTCHA v3 enterprise assessment on signup and login routines to thwart automated attacks. |
| **5** | **JWT Rotation** | 15-minute ephemeral Access Tokens + 7-day Refresh Tokens with cryptographic signature verification. |
| **6** | **2FA Protection** | RFC 6238 TOTP Two-Factor Authentication (Google Authenticator) with QR code provisioning and step-up challenge flows. |
| **7** | **Dual Data Store** | Production MongoDB persistence via Mongoose with an automatic, seamless zero-config fallback to an in-memory repository. |
| **8** | **Credential Vault** | Industry-standard **AES-256-GCM** authenticated encryption with hardware-derived keys for all third-party secrets (GitHub PATs, Render API keys). |
| **9** | **Forensics Engine** | Automated real-time anomaly detection dispatched via Gmail API OAuth 2.0 on unfamiliar IP logins and new API key generation. |
| **10** | **Quotas & Sandbox** | Enforced quotas (maximum 3 API keys per user) + ephemeral subprocess sandboxing with command AST blacklisting. |

---

## 🔐 Security Hardening Tiers

| Tier | Profile | Command Rules & Protections |
| :--- | :--- | :--- |
| **STANDARD** | Development & CI/CD | Blocks destructive system wipe commands (`rm -rf /`, `:(){ :|:& };:`, disk dumps to `/dev/sda`). Output sanitization enabled. |
| **STRICT** | Team & Staging | Everything in STANDARD plus blocking privilege escalations (`sudo`, `su`, `doas`), system file permission tampering (`chmod 777 /`), and process shutdowns. |
| **FORTRESS** | Production / Zero-Trust | Everything in STRICT plus blocking package installation (`apt install`, `pip install`), remote curl piped executions (`curl \| sh`), and enforcing TOTP verification for mutating tools. |

---

## 🔑 Modern MCP OAuth 2.1 & Discovery Specs

Krix natively implements the **Model Context Protocol OAuth 2.1 Authorization Specification** with RFC 8414 server metadata discovery and Proof Key for Code Exchange (PKCE):

- **OAuth Discovery**: `GET /.well-known/oauth-authorization-server`
- **Protected Resource**: `GET /.well-known/oauth-protected-resource`
- **MCP Discovery**: `GET /.well-known/mcp.json`
- **Authorization Endpoint**: `GET /api/auth/oauth/authorize` (supports `code_challenge`, `code_challenge_method=S256`)
- **Token Endpoint**: `POST /api/auth/oauth/token` (Authorization Code exchange & Refresh Token Rotation)
- **Token Revocation**: `POST /api/auth/oauth/revoke`
- **Dynamic Client Registration**: `POST /api/auth/oauth/register` (RFC 7591)

---

## 🛠️ Complete 60+ Tool Catalog

### 1. Core & Repository Management (`core`)
- `set_active_context`: Set default owner, repo, and branch for the session.
- `get_me`: Fetch authenticated user profile details.
- `get_file_contents`: Windowed file viewer with line numbering (max 500 lines).
- `str_replace_editor`: Surgical text block replacement with Levenshtein fuzzy match hints.
- `create_or_update_file`: Atomic file creator and updater.
- `delete_file`: Delete file from repository branch.
- `grep`: Regex-powered code search with glob filters.
- `view_file_outline`: AST outline parser for functions, classes, and exported interfaces.
- `git_tree`: Recursive paginated tree navigator.
- `patch_contents`: Direct line range patcher.
- `list_branches`: List repository branches.
- `create_branch`: Create a new branch from a commit SHA or base branch.
- `delete_branch`: Delete a branch from the repository.
- `push_files`: Atomic multi-file batch commit and push.
- `create_pull_request`: Open a pull request.
- `search_code`: Search code across GitHub.
- `search_repositories`: Search repositories by keyword, language, or stars.
- `sandbox_status`: Inspect runtime status, memory, and active processes.
- `load_toolset`: Dynamically unlock toolset categories (`github_issues_prs`, `github_admin`, `render`, `sandbox`, `all`).

### 2. Issues & Pull Requests (`github_issues_prs`)
- `list_issues`: Filter repository issues by status and label.
- `list_pull_requests`: List pull requests with status filters.
- `issue_read`: Fetch issue descriptions and threaded comments.
- `issue_write`: Create issues or update title, body, state, labels, and assignees.
- `add_issue_comment`: Append markdown comments to issues or PRs.
- `pull_request_read`: Fetch PR details, mergeability status, review comments, and changed files.
- `merge_pull_request`: Merge PRs with `squash`, `merge`, or `rebase` strategies.

### 3. Multi-Runtime Execution Sandbox (`sandbox`)
- `sandbox_run`: Execute scripts in **Python**, **JavaScript**, **TypeScript**, **Bash**, **Go**, **Java**, or **C++**.
- `sandbox_exec`: Execute arbitrary sandboxed shell commands with timeout enforcement.
- `sandbox_install`: Install dependencies into workspace (`npm`, `pip`).
- `sandbox_ps`: List active processes running in the session sandbox.
- `sandbox_reset`: Terminate all active processes and purge the workspace.
- `git_clone`: Clone a remote repository into the sandbox workspace.
- `git_checkout`: Switch or create branches locally in the sandbox.
- `git_pull`: Pull upstream updates into the sandbox repo.
- `git_status`: Check git status and staged changes.
- `git_diff`: View uncommitted diffs.
- `git_commit_push`: Stage, commit, and push local sandbox changes.

### 4. Render Cloud Infrastructure (`render`)
- `list_workspaces`: List accessible Render cloud workspaces.
- `select_workspace`: Set active workspace for operations.
- `get_selected_workspace`: Retrieve active workspace metadata.
- `list_services`: List web services, static sites, background workers, and cron jobs.
- `get_service`: Inspect configuration and status of a service.
- `create_web_service`: Deploy web applications from GitHub repos.
- `create_static_site`: Deploy static web apps.
- `create_cron_job`: Schedule background cron jobs.
- `restart_service`: Zero-downtime service restart.
- `delete_service`: Permanently destroy a Render service.
- `list_deploys`: List recent deployment history.
- `get_deploy`: Inspect deployment logs and build states.
- `trigger_deploy`: Trigger manual deploys with optional cache purge.
- `cancel_deploy`: Cancel active deployment builds.
- `list_logs`: Stream runtime container logs.
- `get_metrics`: Real-time telemetry for CPU, Memory, and Bandwidth.
- `list_env_vars`: List environment variables for a service.
- `update_env_vars`: Add or update environment variables.
- `delete_env_var`: Remove environment variables.
- `query_render_postgres`: Execute read-only SQL `SELECT` queries against managed databases.

---

## 🔌 Connecting to AI Clients

### Claude Desktop Configuration
Add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "krix": {
      "url": "https://your-krix-domain.onrender.com/mcp",
      "headers": {
        "x-api-key": "krix_live_YOUR_API_KEY"
      }
    }
  }
}
```

### Cursor IDE Configuration
In **Cursor Settings > Features > MCP**:
1. Click **+ Add New MCP Server**
2. Name: `Krix`
3. Type: `HTTP / SSE`
4. URL: `https://your-krix-domain.onrender.com/mcp`
5. Custom Headers: `{"x-api-key": "krix_live_YOUR_API_KEY"}`

---

## 📜 Compliance & Policies

- **Privacy Policy & Terms**: See [policy.md](policy.md) for Google OAuth Limited Use Compliance and security policies.
- **Brand Assets**: Logos, vector icons, and favicon files are served from [`public/`](public/).

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).

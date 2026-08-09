# Security

Krix runs untrusted-adjacent AI-agent workloads (shell execution, file access, GitHub
and Render credentials) behind a single HTTP gateway. This document describes the
threat model, what's actually isolated, and what you're responsible for.

## Threat model

Krix assumes:

- The **operator** (whoever sets `MCP_API_KEY` / `MCP_REFRESH_TOKEN` / provider tokens)
  is trusted.
- **MCP clients** that hold a valid access key or OAuth token are trusted to use the
  tools they're given — Krix isolates sessions from each other, but does not defend
  against a legitimately-authenticated client deliberately misusing its own access.
- **Sandboxed command output** (stdin/stdout of `sandbox_exec`, cloned repo contents,
  etc.) is *not* trusted, and is treated as potentially adversarial input.

## Authentication

- **OAuth 2.1 + PKCE (S256)**: exact redirect-URI matching, one-time authorization
  codes (60s TTL), opaque bearer access tokens (1h TTL by default), and revocation.
  Dynamic client registration is public-client only (`token_endpoint_auth_method:
  none`), which is standard for this class of client and is why PKCE is mandatory.
- **Legacy API key** (`ALLOW_LEGACY_API_KEY=true`, default on): `MCP_API_KEY` accepted
  directly as a bearer token. This is not a lesser security tier — it's gated on the
  same secret as OAuth — just a different UX. Turn it off if you want every client to
  go through the (revocable, rotatable) OAuth flow instead.
- **Refresh tokens** (`MCP_REFRESH_TOKEN`, optional): a static, operator-configured
  secret that lets clients silently mint new access tokens, including across
  restarts/redeploys where the in-memory token store is wiped. Treat it as a second
  master secret — anyone who has it can obtain a valid access token at any time.
- All secrets are compared with `crypto.timingSafeEqual` to avoid timing side channels.

## Session isolation

- Every MCP session is bound to the specific authorization (OAuth token fingerprint, or
  the shared legacy key) that created it; a session cannot be resumed by a different
  authorization.
- Sandbox filesystems are keyed per session under `/tmp/krix_sbx_<key>/` and are not
  shared across sessions unless `ENABLE_CONTEXT_RESUME=true` and the *same* GitHub
  token reconnects within `AUTH_CONTEXT_TTL_MS`.

## Sandbox isolation

- Sandbox tool execution runs inside [`bwrap`](https://github.com/containers/bubblewrap)
  when the environment supports unprivileged user namespaces: a read-only view of `/usr`,
  `/bin`, `/lib`, `/etc`, an isolated `/tmp`, no access to other sessions' directories,
  and network access denied by default (only specific operations like `install_packages`
  and `git_*` get it, and only to perform that operation).
- Not every hosting platform allows unprivileged user namespaces (Render and similar
  managed PaaS hosts commonly don't). When that's the case and `ALLOW_UNSAFE_HOST_SANDBOX
  =true`, Krix falls back to running sandboxed commands directly inside the container.
  This still isolates the sandbox from your host machine (via Docker), but **not** from
  the rest of the Krix process/container — a malicious command could, in principle,
  affect other sessions' sandbox directories or the container's resources. Run
  `sandbox_status` to see which mode is actually active (`effectiveSandboxMode`).
- `git_*` operations run outside `bwrap` directly (they need network access and write
  into the shared sandbox root), but are restricted to a fixed, validated argument set
  (branch/ref names, repo owner/name, and file paths are all pattern-validated) and a
  hardened git config (`credential.helper=`, `protocol.file.allow=never`, no hooks) —
  they cannot run arbitrary git subcommands or reach outside the target repo.
- File writes/reads are size-capped (20MB) and resolve symlinks before checking the
  sandbox boundary, so a symlink can't be used to read/write outside the sandbox root.
- A command blocklist rejects obviously destructive patterns (`rm -rf /`, `mkfs`, `dd
  if=`, fork bombs, and privilege-escalation/namespace tools like `sudo`, `mount`,
  `docker`) as defense-in-depth on top of the isolation above — it is not itself the
  security boundary.

## Credential handling

- Server-side GitHub/Render tokens are never returned to clients.
- All tool output is passed through credential redaction before being returned:
  `ghp_*`, `github_pat_*`, `rnd_*`, `sk-*`, AWS-style `AKIA*` keys, `Authorization:
  Bearer` values, `x-api-key` values, and PEM-format private keys are masked.
- `ALLOW_CLIENT_CREDENTIAL_HEADERS=false` (default) means a client cannot make Krix act
  with credentials the client supplies at request time — only the operator-configured
  server-side tokens are used. Only enable this if you specifically need per-client
  credential routing, and understand that any authenticated client can then cause the
  server to make authenticated calls with whatever token it sends.

## Network hardening

- Strict security headers on every response (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, a locked-down `Permissions-Policy`, `Cross-Origin-*` isolation, and
  HSTS in production).
- Origin validation against `PUBLIC_BASE_URL` and `MCP_ALLOWED_ORIGINS`.
- Per-IP rate limiting on `/mcp` and every `/oauth/*` endpoint, with `Retry-After`.
- Request/header/body size and timeout limits to bound resource usage per connection.

## Operator responsibilities

- Use a long, random `MCP_API_KEY` and (if set) `MCP_REFRESH_TOKEN` — treat both as
  master secrets, not passwords.
- Set `NODE_ENV=production` and a real HTTPS `PUBLIC_BASE_URL` before exposing the
  service publicly — Krix refuses to start in production without these.
- Keep `GITHUB_PERSONAL_ACCESS_TOKEN` / `RENDER_API_KEY` scoped as narrowly as your
  workflow allows (e.g. a fine-grained GitHub token limited to the repos you intend to
  use with Krix).
- If you deploy somewhere that *does* support `--cap-add=SYS_ADMIN` / `--privileged`
  containers, prefer that for full `bwrap` isolation rather than relying on the
  host-mode fallback.

## Reporting a vulnerability

If you find a security issue in Krix, please open a private security advisory on the
GitHub repository (or contact the maintainer directly) rather than a public issue, and
include reproduction steps. Please give a reasonable window to address the issue before
any public disclosure.

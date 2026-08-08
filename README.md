# Krix

**Krix** is a secure, extensible MCP gateway that gives AI agents controlled access to GitHub, Render, local Git repositories, and an isolated sandbox environment.

It is designed for AI coding agents that need to inspect repositories, modify files, work with Git, interact with GitHub, manage Render resources, and execute code — while keeping authentication, filesystem access, processes, networking, and resource usage under explicit control.

> **Security-first principle:** Krix gives powerful capabilities to AI agents. Every capability therefore has explicit boundaries around authentication, filesystem access, process execution, networking, resource usage, and external API access.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [Sandbox](#sandbox)
- [Sandbox Isolation](#sandbox-isolation)
- [Network Access](#network-access)
- [Authentication](#authentication)
- [GitHub Integration](#github-integration)
- [Render Integration](#render-integration)
- [Tool Loading](#tool-loading)
- [Resource Limits](#resource-limits)
- [Memory Protection](#memory-protection)
- [Session Management](#session-management)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Installation](#installation)
- [Local Development](#local-development)
- [Docker](#docker)
- [Production Deployment](#production-deployment)
- [API Authentication](#api-authentication)
- [Security Levels](#security-levels)
- [Git Operations](#git-operations)
- [Sandbox Tools](#sandbox-tools)
- [GitHub Tools](#github-tools)
- [Render Tools](#render-tools)
- [Resource Cleanup](#resource-cleanup)
- [Operational Guidance](#operational-guidance)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [Limitations](#limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

# Features

Krix provides a unified MCP interface for several development and infrastructure capabilities.

### GitHub

Krix can interact with GitHub repositories and development workflows, including:

- Repository discovery
- Repository information
- File inspection
- File modification
- Branch operations
- Commit operations
- Pull requests
- Issues
- Labels
- Issue types
- Issue fields
- Reviews
- Review comments
- Sub-issues
- Secret scanning
- Repository search
- Multi-file commits

GitHub operations are performed through the GitHub API rather than relying on fragile shell commands whenever an API equivalent exists.

### Local Git

Krix provides controlled Git functionality inside the sandbox, including:

- Clone
- Fetch
- Pull
- Checkout
- Diff
- Status
- Commit
- Push
- Repository inspection

Git commands are executed with argument-safe process APIs rather than interpolating user-controlled values into shell commands.

### Sandbox

Krix provides an isolated execution environment for AI agents.

The sandbox supports:

- Shell commands
- Persistent shell sessions
- Background processes
- File operations
- Search
- Git operations
- Package installation
- Multiple programming languages
- Compilation
- Code execution

The sandbox is protected by:

- Filesystem containment
- Path validation
- Symlink checks
- Environment filtering
- Resource limits
- Process limits
- Output limits
- Execution timeouts
- Bubblewrap isolation
- Linux namespaces
- Capability dropping
- Optional network isolation

### Render

Krix can interact with Render through its API/MCP integration.

Render functionality includes:

- Service discovery
- Service management
- MCP session handling
- Resource inspection
- API-backed operations

Render credentials are kept separate from sandbox execution and are never intentionally exposed to sandbox processes.

---

# Architecture

At a high level, Krix follows this architecture:

```text
                         AI Agent
                            │
                            │ MCP
                            ▼
                    ┌───────────────┐
                    │     Krix      │
                    │   MCP Server  │
                    └───────┬───────┘
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
        ┌─────────┐   ┌──────────┐   ┌──────────┐
        │ GitHub  │   │  Render  │   │  Local   │
        │  Tools  │   │  Tools   │   │   Git    │
        └─────────┘   └──────────┘   └────┬─────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │   Sandbox   │
                                   └──────┬──────┘
                                          │
                                   ┌──────▼──────┐
                                   │ Bubblewrap  │
                                   │ Isolation   │
                                   └─────────────┘
```

The sandbox is intentionally treated differently from the GitHub and Render integrations.

GitHub and Render credentials belong to the Krix server.

Sandbox processes should receive only the environment and filesystem access required to perform their task.

---

# Security Model

Krix assumes that an AI agent may submit unexpected or malicious input.

Therefore, user-controlled values are treated as untrusted.

This includes:

- File paths
- Commands
- Shell arguments
- Git branches
- Repository names
- Search expressions
- Regular expressions
- Environment variables
- Commit messages
- Issue content
- Package names
- Render parameters
- Network-related settings

Security controls are applied at multiple layers rather than relying on a single validation function.

```text
Input validation
      ↓
Authentication
      ↓
Authorization / capability checks
      ↓
Filesystem validation
      ↓
Process isolation
      ↓
Environment filtering
      ↓
Resource limits
      ↓
Output limits
      ↓
Cleanup
```

This defense-in-depth approach is important because no single application-level validation mechanism is sufficient for arbitrary code execution.

---

# Sandbox

Krix's sandbox is designed around a simple rule:

> The AI agent may work inside its assigned workspace, but the Krix server itself is not part of that workspace.

Each sandbox has a controlled workspace and a restricted execution environment.

The sandbox root is authoritative.

A caller cannot redefine the sandbox root simply by supplying a different `cwd`.

## Filesystem Security

Krix validates filesystem paths before using them.

The sandbox prevents common escape techniques such as:

```text
../
../../
/etc/passwd
/tmp/other-directory
```

It also accounts for:

- Symlinks
- Symlinked parent directories
- Absolute paths
- Relative paths
- Path-prefix collisions
- Existing filesystem targets

A lexical string check such as `startsWith("/sandbox")` is not considered sufficient.

Filesystem-aware validation is used where necessary.

---

# Sandbox Isolation

For Linux deployments, Krix uses **Bubblewrap (`bwrap`)** for sandbox execution.

Bubblewrap provides Linux namespace-based isolation.

The sandbox uses isolation for:

- Mounts
- PIDs
- IPC
- UTS
- User namespace
- Linux capabilities

The sandbox filesystem is constructed explicitly.

Only required system resources are exposed.

The Krix application directory is not intentionally mounted into the sandbox.

The sandbox workspace is the writable development area.

## Sandbox Filesystem Layout

Conceptually, a sandbox looks like:

```text
/
├── bin/              read-only
├── usr/              read-only
├── lib/              read-only
├── lib64/            read-only
├── etc/              controlled
├── tmp/              isolated
├── run/              isolated
├── home/             isolated
└── workspace/        writable
```

The exact layout depends on the host image and installed runtimes.

## Fail-Closed Isolation

When:

```env
SANDBOX_ISOLATION_REQUIRED=true
```

Krix requires Bubblewrap.

If Bubblewrap is unavailable, sandbox execution should fail instead of silently falling back to an unisolated child process.

This prevents an operational configuration mistake from accidentally disabling the intended security boundary.

---

# Network Access

Krix allows network access to be configured independently for the major network-capable operations.

The defaults are currently enabled:

```env
SANDBOX_EXEC_NETWORK_DEFAULT=true
SANDBOX_RUN_NETWORK_DEFAULT=true
SANDBOX_INSTALL_NETWORK_DEFAULT=true
GIT_NETWORK_DEFAULT=true
```

These control different capabilities.

### `SANDBOX_EXEC_NETWORK_DEFAULT`

Default network policy for sandbox execution.

### `SANDBOX_RUN_NETWORK_DEFAULT`

Default network policy for sandbox run operations.

### `SANDBOX_INSTALL_NETWORK_DEFAULT`

Default network policy for package installation.

Package managers commonly require network access.

### `GIT_NETWORK_DEFAULT`

Default network policy for Git operations such as clone, fetch, pull, and push.

## Network Security Warning

Network-enabled sandbox execution is powerful.

When network access is enabled, sandbox code may be able to communicate with services reachable from the Render environment.

Application-level restrictions cannot provide the same guarantees as a dedicated outbound firewall or proxy.

For high-security deployments, consider routing sandbox traffic through a controlled egress proxy or disabling sandbox networking unless it is required.

---

# Authentication

Krix supports gateway authentication using:

```text
x-api-key
```

or:

```text
Authorization: Bearer <key>
```

The gateway key is configured through:

```env
MCP_API_KEY=
```

API keys should not be supplied through URLs.

Avoid query-string secrets because URLs may appear in logs, tracing systems, proxies, browser history, or monitoring systems.

## MCP OAuth Authentication

For Claude, Cursor, Gemini Spark, AntiGravity, or any OAuth-capable MCP client, Krix provides built-in, stateless OAuth 2.0 authorization server support with Dynamic Client Registration (DCR), PKCE (S256), anti-CSRF tokens, sliding-window rate limiting, and dynamic client logo resolution.

Configure the following environment variables in `.env`:

```env
# MCP OAuth (required for Claude / OAuth-capable MCP clients)
# Set this to the exact public Krix URL, with no trailing slash.
OAUTH_ISSUER=your_web_service_url
# Long random secret (32+ characters). Keep this unchanged across redeploys.
OAUTH_SIGNING_SECRET=your_33_characters_secret
```

---

# GitHub Authentication

GitHub credentials can be supplied through environment configuration or request headers depending on the deployment configuration.

Example:

```env
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_github_token_here
```

An alternative alias may also be used:

```env
GITHUB_PAT=ghp_your_github_token_here
```

Clients may provide a GitHub token through the supported request header when configured to do so.

GitHub credentials should never be:

- committed to Git
- placed in source code
- embedded in sandbox commands
- written into logs
- included in Git remote URLs unnecessarily

---

# Render Authentication

Render authentication is configured through:

```env
RENDER_API_KEY=rnd_your_render_api_key_here
```

The alternative alias:

```env
RENDER_PAT=rnd_your_render_api_key_here
```

may also be used where supported.

Render credentials remain server-side.

They should not be inherited by arbitrary sandbox processes.

---

# Tool Loading

Krix supports lazy tool loading.

By default:

```env
ENABLE_ALL_TOOLS=false
```

This allows the server to avoid registering every capability when it is unnecessary.

Category flags include:

```env
ENABLE_GITHUB_ISSUES_PRS=false
ENABLE_GITHUB_ADMIN=false
ENABLE_RENDER=false
ENABLE_SANDBOX=true
```

Enable only the capabilities required by your deployment.

For development environments, enabling additional capabilities may be convenient.

For production, least privilege is recommended.

---

# Resource Limits

Krix is designed to run within constrained environments such as a 512 MB Render instance.

Resource limits exist because an AI agent can unintentionally or intentionally create extremely expensive operations.

Limits apply to:

- Sessions
- Processes
- Shells
- Executions
- Queues
- Output
- Environment variables
- Files
- Git pushes
- Render responses
- Sandbox storage

## Session Limits

```env
MAX_MCP_SESSIONS=24
MAX_AUTH_CONTEXTS=128
```

These prevent unbounded growth of in-memory session state.

Expired entries are cleaned automatically.

## Process Limits

```env
MAX_BACKGROUND_PROCESSES=16
MAX_BACKGROUND_PROCESSES_PER_AUTH=8
MAX_PERSISTENT_SHELLS=12
```

This prevents a single agent or many agents from creating an unlimited number of child processes.

## Execution Limits

```env
MAX_CONCURRENT_EXECUTIONS=4
MAX_EXECUTION_QUEUE=8
```

Only a bounded number of expensive sandbox executions run simultaneously.

Additional requests may wait in the bounded queue.

This helps prevent CPU and memory spikes.

## Execution Timeouts

Normal execution:

```env
EXECUTION_TIMEOUT_MS=300000
```

Background execution:

```env
BACKGROUND_PROCESS_TIMEOUT_MS=600000
```

Processes that exceed their allowed lifetime are terminated.

---

# Output Limits

Command output can consume large amounts of memory.

Krix therefore caps output.

Persistent shells:

```env
PERSISTENT_SHELL_OUTPUT_LIMIT=1048576
```

Output caches are limited by both entry count, total memory, per-session count, and TTL.

Example:

```env
MAX_OUTPUT_CACHE_ENTRIES=64
MAX_OUTPUT_CACHE_BYTES=33554432
MAX_OUTPUT_CACHE_PER_SESSION=10
OUTPUT_CACHE_TTL_MS=900000
```

This prevents output from becoming an indefinitely growing in-memory data structure.

---

# Environment Limits

Sandbox environment variables are bounded.

```env
MAX_ENV_VARS=128
MAX_ENV_BYTES=262144
```

Both the number of variables and their combined size are limited.

Sensitive server variables are filtered.

Dangerous runtime configuration variables such as `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `GIT_SSH_COMMAND`, and `GIT_ASKPASS` are restricted to prevent them from becoming indirect escape mechanisms.

---

# Sandbox Storage Limits

Individual file size:

```env
MAX_SANDBOX_FILE_SIZE=16777216
```

Maximum sandbox storage:

```env
MAX_SANDBOX_SIZE=268435456
```

The sandbox storage limit is intended to prevent uncontrolled disk growth.

For a 512 MB Render instance, keeping workload sizes bounded is important because large generated datasets can also create CPU, I/O, and memory pressure.

---

# Git Push Limits

Krix limits large multi-file Git operations.

```env
MAX_PUSH_FILE_SIZE=4194304
MAX_PUSH_TOTAL_SIZE=16777216
```

This prevents a single tool call from attempting to construct an excessively large Git operation.

---

# Render Limits

Render responses are bounded:

```env
MAX_RENDER_RESPONSE_SIZE=8388608
```

Cached Render sessions are also limited:

```env
MAX_RENDER_SESSIONS=8
```

Stale entries are removed after their TTL.

---

# Memory Protection

Krix monitors process RSS rather than relying only on Node's JavaScript heap usage.

Memory pressure begins around:

```env
MEMORY_PRESSURE_MB=360
```

Emergency cleanup begins around:

```env
MEMORY_EMERGENCY_MB=440
```

These thresholds are deliberately below the 512 MB service limit to provide headroom for:

- Native allocations
- Child processes
- Node runtime overhead
- Buffers
- Libraries
- OS overhead

These values are safety thresholds, not a replacement for an operating-system memory limit.

---

# Session Management

Krix maintains session state so that MCP clients can maintain continuity.

Session state is not intended to grow indefinitely.

Inactive sessions are removed after:

```env
SESSION_IDLE_TIMEOUT_MS=600000
```

Authentication context persistence:

```env
AUTH_CONTEXT_TTL_MS=3600000
```

Render session cache:

```env
RENDER_SESSION_TTL_MS=1800000
```

---

# Shared Sandbox Identity

Krix intentionally uses the authenticated identity when determining the shared sandbox.

This means multiple sessions belonging to the same authenticated identity may use the same sandbox.

It should not be interpreted as a per-MCP-session sandbox.

```text
GitHub Identity A
       │
       ▼
Shared Auth Identity A
       │
       ▼
Sandbox A
     ↙   ↘
Session 1  Session 2
```

A different authenticated identity receives a different sandbox context.

---

# Session Identity Consistency

Although the sandbox is shared by identity, an individual MCP session cannot silently switch identities.

For example:

```text
Session 123 → User A
```

followed by an attempt to use:

```text
Session 123 → User B
```

should be rejected.

This prevents state created under one identity from being reused under another identity.

---

# Sandbox Destruction

Sandbox destruction remains associated with the shared authenticated identity.

If another active session is still using the same shared identity, closing one session must not unnecessarily destroy resources required by the remaining session.

---

# Git Operations

Git operations use process APIs with explicit argument arrays wherever possible.

This is safer than constructing shell commands from untrusted values.

Git credentials should not be placed directly in command-line arguments.

## Git Hooks

Git operations involving credentials should avoid executing untrusted repository hooks where possible.

This reduces the risk of a malicious repository executing code with access to the Krix environment during Git operations.

---

# GitHub API Correctness

Krix uses the GitHub API for GitHub-specific operations.

API endpoints should match their semantic purpose.

Examples include:

- Repository issue types use the repository issue-type endpoint.
- Organization issue fields use the appropriate organization-level API.
- Sub-issues use GitHub's supported sub-issue relationship functionality.
- Pending review comments use the review workflow rather than pretending a normal issue comment is a pending review comment.

Krix does not fabricate repository configuration when the GitHub API does not return it.

---

# Safe File Replacement

The `str_replace_editor` operation is intentionally strict.

The replacement target must occur exactly once.

```text
0 matches
→ error

1 match
→ replace

2+ matches
→ error
```

When multiple occurrences exist, the tool reports their locations so an AI agent can refine its target.

Example:

```text
old_str is ambiguous; found 3 occurrences.

Occurrence 1: line 42
Occurrence 2: line 87
Occurrence 3: line 156

No changes were made.
Provide a more specific old_str.
```

This prevents accidental modification of the wrong section of a file.

---

# Repository Search

When exact repository matching is requested, Krix does not treat a fuzzy similarity match as an exact match.

For example, `Krix` should not silently resolve to `Krix-old` when exact matching was requested.

Fuzzy searching and exact searching are treated as different semantics.

---

# Regex Safety

User-provided regular expressions can consume significant CPU if they contain pathological patterns.

Krix therefore applies validation and limits to dangerous regex operations.

Regexes should not be treated as inherently safe merely because they are syntactically valid.

---

# Error Handling

Krix aims to return useful errors without exposing sensitive server information.

Errors should not intentionally disclose:

- API keys
- GitHub tokens
- Render tokens
- private keys
- server-side environment variables
- unnecessary stack traces
- sensitive command-line arguments

Output sanitization is an additional defense layer, not the primary secret-protection mechanism.

---

# Installation

## Requirements

Recommended environment:

- Linux
- Node.js
- npm
- Git
- Bubblewrap (`bwrap`)
- Docker for containerized deployment

For production sandbox execution, Linux namespace support is required.

## Local Development

Clone the repository:

```bash
git clone https://github.com/imanki-t/Krix.git
cd Krix
```

Install dependencies:

```bash
npm ci
```

Create the environment file:

```bash
cp .env.example .env
```

Edit `.env` and provide the required credentials.

Start the development server using the repository's configured development script.

---

# Docker

The recommended production deployment uses Docker.

Build:

```bash
docker build -t krix .
```

Run:

```bash
docker run --rm \
  --env-file .env \
  -p 3000:3000 \
  krix
```

The Docker image includes Bubblewrap for sandbox isolation.

---

# Production Deployment

For a constrained deployment such as a 512 MB Render service, the recommended configuration is:

```env
ENABLE_ALL_TOOLS=false
ENABLE_SANDBOX=true
SANDBOX_ISOLATION_REQUIRED=true
SANDBOX_SECURITY_LEVEL=high
```

Network defaults may remain enabled if your workflows require them:

```env
SANDBOX_EXEC_NETWORK_DEFAULT=true
SANDBOX_RUN_NETWORK_DEFAULT=true
SANDBOX_INSTALL_NETWORK_DEFAULT=true
GIT_NETWORK_DEFAULT=true
```

If the deployment does not require internet access from arbitrary sandbox commands, disable it.

---

# 512 MB Render Considerations

Krix is designed with the 512 MB class of deployment in mind.

However, 512 MB is the limit for the entire service, not merely the Node.js heap.

Memory can be consumed by:

```text
Node.js
+
Krix
+
MCP SDK
+
GitHub client
+
Render client
+
Buffers
+
Child processes
+
Compilers
+
Git
+
npm
+
Bubblewrap
```

Therefore Krix intentionally leaves memory headroom.

Application-level limits reduce the probability of uncontrolled memory growth, but they cannot replace the platform's resource controls.

For workloads involving large compilers, large repositories, or heavy parallel execution, a larger instance is recommended.

---

# API Authentication

Clients should authenticate with:

```http
x-api-key: YOUR_KEY
```

or:

```http
Authorization: Bearer YOUR_KEY
```

Never place gateway secrets in URLs.

---

# Security Levels

Krix supports security restriction levels:

```text
low
medium
high
```

Example:

```env
COMMAND_RESTRICTION_LEVEL=low
NETWORK_RESTRICTION_LEVEL=low
SANDBOX_SECURITY_LEVEL=high
```

Higher levels should impose stricter restrictions.

For production environments, `high` is recommended where functionality permits.

---

# Resource Cleanup

Krix uses TTL-based cleanup for transient state.

Cleanup covers areas such as:

- MCP sessions
- Authentication contexts
- Output caches
- Render sessions
- Background processes
- Persistent shells

Cleanup is designed to be idempotent where possible.

This is important because multiple lifecycle events may occur for the same session.

---

# Process Cleanup

Background processes have bounded lifetimes.

When processes terminate:

- output buffers are released
- timers are cleared
- process metadata is removed
- empty process tables are removed

This prevents exited processes from leaving unnecessary objects in memory.

---

# Persistent Shell Cleanup

Persistent shells are bounded and associated with session/auth lifecycle.

Their output buffers are capped.

When no longer required, the shell is terminated and its state is removed.

---

# Temporary Files

Compilation and execution may create temporary files.

These files are contained within the sandbox workspace and are removed when the shared sandbox is destroyed.

Long-lived workloads should still avoid unnecessarily generating huge numbers of temporary files.

---

# Security Best Practices

For production:

1. Use a long random `MCP_API_KEY`.
2. Never commit `.env`.
3. Use the smallest GitHub permissions necessary.
4. Use the smallest Render permissions necessary.
5. Keep Bubblewrap isolation enabled.
6. Keep the sandbox security level high.
7. Disable sandbox networking when it is not required.
8. Monitor Render memory and CPU usage.
9. Keep dependencies updated.
10. Do not expose the Krix gateway publicly without authentication.
11. Rotate compromised credentials immediately.
12. Avoid running untrusted workloads on infrastructure containing unrelated secrets.

---

# Threat Model

Krix assumes that the AI agent can provide malicious input.

Potential attacks include:

- Path traversal
- Symlink traversal
- Command injection
- Shell injection
- Environment-variable manipulation
- Regex denial of service
- Memory exhaustion
- CPU exhaustion
- Disk exhaustion
- Process exhaustion
- Session confusion
- API misuse
- Malicious Git repositories
- Malicious Git hooks
- Oversized requests
- Oversized command output

Krix uses multiple controls to reduce these risks.

---

# Important Security Limitation

Bubblewrap significantly improves isolation, but it is not a virtual machine.

Krix still runs inside the same Render service/container.

The sandbox is therefore:

```text
strong application + Linux namespace isolation
```

rather than:

```text
independent VM
```

For hostile multi-tenant workloads requiring extremely strong isolation, use a dedicated sandbox service, microVM, or VM-based execution environment.

---

# Network Security Limitation

When sandbox networking is enabled, the sandbox can potentially reach network destinations accessible from the Render service.

The following:

```env
SANDBOX_EXEC_NETWORK_DEFAULT=true
```

does not mean "internet access only."

It means network access is available according to the sandbox/network environment.

For strict egress control, use a network firewall or proxy outside Krix.

---

# Troubleshooting

## Bubblewrap is missing

If:

```env
SANDBOX_ISOLATION_REQUIRED=true
```

and `bwrap` cannot be found, sandbox execution will fail.

Install Bubblewrap or use the provided Docker image.

## Sandbox execution is rejected

Check:

```env
ENABLE_SANDBOX=true
SANDBOX_ISOLATION_REQUIRED=true
```

Then verify that Bubblewrap is installed and namespace support is available.

## Network operation fails

Check the appropriate variable:

```env
SANDBOX_EXEC_NETWORK_DEFAULT=true
SANDBOX_RUN_NETWORK_DEFAULT=true
SANDBOX_INSTALL_NETWORK_DEFAULT=true
GIT_NETWORK_DEFAULT=true
```

A capability may require network access even if another capability has it enabled.

## Resource limit reached

If Krix reports a session, process, queue, output, or memory limit:

1. Check whether workloads are still running.
2. Allow idle resources to expire.
3. Reduce concurrent operations.
4. Increase the relevant limit only if the deployment has sufficient resources.
5. Monitor Render memory before increasing limits.

Do not blindly increase every limit on a 512 MB service.

---

# Development

The repository is TypeScript-based.

When modifying Krix:

1. Understand the existing architecture.
2. Preserve security boundaries.
3. Avoid introducing shell interpolation.
4. Validate all user-controlled paths.
5. Bound all untrusted resource usage.
6. Add cleanup for every new long-lived resource.
7. Add TTLs where appropriate.
8. Add maximum sizes where appropriate.
9. Test error paths.
10. Test concurrent behavior.

---

# Security Review Checklist

Before shipping a change:

### Input

- [ ] Is user input validated?
- [ ] Is maximum size enforced?
- [ ] Is maximum count enforced?

### Filesystem

- [ ] Is the path contained within the sandbox?
- [ ] Are symlinks handled?
- [ ] Can `..` escape?
- [ ] Can absolute paths escape?

### Processes

- [ ] Is the command argument-safe?
- [ ] Is shell execution actually necessary?
- [ ] Is there a timeout?
- [ ] Is output bounded?
- [ ] Is process count bounded?
- [ ] Is cleanup guaranteed?

### Environment

- [ ] Are secrets excluded?
- [ ] Are dangerous runtime variables restricted?
- [ ] Is total environment size bounded?

### Network

- [ ] Is network access actually required?
- [ ] Is it controlled by configuration?
- [ ] Could arbitrary network access expose internal services?

### Memory

- [ ] Is the allocation bounded?
- [ ] Is the cache bounded?
- [ ] Is there a TTL?
- [ ] Is there a global maximum?

### Sessions

- [ ] Can identity change unexpectedly?
- [ ] Is session cleanup guaranteed?
- [ ] Are shared resources reference-counted appropriately?

---

# Contributing

When contributing to Krix, security-sensitive changes should include tests.

Particularly important areas include:

- Sandbox isolation
- Authentication
- Git operations
- Path validation
- Process management
- Resource limits
- GitHub API integrations
- Render API integrations

Avoid introducing dependencies solely to replace simple, well-understood functionality unless the dependency provides a meaningful security or maintenance benefit.

---

# Reporting Security Issues

Do not publicly disclose sensitive vulnerabilities before they have been responsibly addressed.

If you discover:

- authentication bypass
- sandbox escape
- credential exposure
- command injection
- arbitrary filesystem access
- remote code execution outside the intended sandbox
- cross-session authorization issues

treat the issue as high priority.

---

# License

See the repository's `LICENSE` file for the applicable license.

---

# Summary

Krix is designed to give AI agents powerful development capabilities without giving those capabilities unrestricted access to the Krix server.

Its security model combines:

```text
Authentication
      +
Input validation
      +
Filesystem containment
      +
Bubblewrap isolation
      +
Linux namespaces
      +
Environment filtering
      +
Network controls
      +
Process limits
      +
Memory limits
      +
Output limits
      +
TTL cleanup
      +
API-level validation
```

The objective is not to make arbitrary code execution magically risk-free.

The objective is to ensure that every powerful capability has a clearly defined boundary, that resources cannot grow indefinitely, and that failures are handled safely rather than silently weakening the security model.

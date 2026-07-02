# Unified GitHub & Render MCP Gateway

This repository contains a lightweight, single-port Model Context Protocol (MCP) server that merges local GitHub utility tools with a curated, token-efficient proxy to official Render developer actions.

By filtering down heavy JSON payloads locally and providing highly parameterized search, grep, and pagination limits, this gateway reduces startup overhead and conversational context consumption compared to a standard, unoptimized registration.

---

## Features

### 1. GitHub Integration (16 Tools)
*   **Repository Access:** `get_viewer`, `list_repos`, `search_repos`, `list_branches`
*   **Code Discovery:** `search_code`, `grep`, `get_tree`, `view_file_outline`
*   **File Manipulation:** `get_contents`, `str_replace_editor`, `put_contents`, `patch_contents`, `delete_contents`
*   **Git Control:** `create_ref`, `delete_ref`, `create_pull`

### 2. Streamlined Render Integration (8 Tools)
To prevent your chat limits from draining due to schema overhead and verbose responses, the following Render tools are registered as a proxy over the Render MCP server:
*   `list_workspaces` — Lists available personal and team Render workspaces.
*   `select_workspace` — Switches context to a specific workspace ID.
*   `get_selected_workspace` — Identifies the active workspace configuration.
*   `list_services` — Lists and searches web services, background workers, and databases using substring or regex filters.
*   `get_service` — Inspects the direct configuration and runtime status of a service.
*   `list_deploys` — Retrieves deployment success/failure history.
*   `get_deploy` — Gets exact details of a specific build phase.
*   `list_logs` — Pulls application server logs with configurable search limits.

24 tools total. Render sessions are established lazily against `https://mcp.render.com/mcp` and cached per API key, with automatic re-initialization on session expiry.

---

## Token Optimization & Context Protection

The gateway implements several server-side design practices to keep conversational context windows clean:

### Local Payload Pruning
Downstream REST responses (specifically from Render) often contain vast, deeply-nested configuration structures. This gateway intercept and cleans those payloads—removing redundant workspace billing blocks, configuration schemas, and environment arrays—mapping them into highly simplified structures before presenting them to the model.

### Regex-Powered Service Filtering (`list_services`)
Instead of fetching and outputting a full array of services to the model, the `list_services` tool performs local substring and regular expression matching on the server. The model can target specific resources—for example, searching `"grumm"` to immediately isolate services connected to a specific repository—and paginate results cleanly via `limit` and `offset` variables.

### Scalable Code Inspection (`get_contents`)
*   **Controllable Window**: Defaults to a safe reading size of **300 lines**.
*   **Max Capacity**: Allows the model to request up to **750 lines** using the `limit` or `endLine` parameters when broader contextual scans are necessary.
*   **Continuation Prompts**: Truncated results append clear paging guides indicating exactly how to call subsequent blocks.

### Code Searches & Match Contexts
*   **Code Search (`search_code`)**: Limits result structures to targeted fragments rather than entire files (max 20 files, `fragmentLines` up to 10) so the model can request more surrounding code when needed.
*   **Localized Grepping (`grep`)**: Rather than reading entire files to locate reference terms, `grep` supports regex or literal pattern matching with `context_before`/`context_after` (up to 10 lines each), a `glob`/`type` filter, and three output modes (`content`, `files_with_matches`, `count`). If a direct file `path` is given, it scans that file directly instead of hitting the search index.
*   **File Outline (`view_file_outline`)**: Pulls high-level symbol structures (functions, classes, imports) from a file without loading its raw contents — useful for orienting on large files before editing.

---

## Configuration

Duplicate `.env.example` as `.env` and fill out your credentials:

```bash
cp .env.example .env

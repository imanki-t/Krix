# Krix MCP Agentic Tools Guide (Remote GitHub Operations)

This reference guide provides exhaustive documentation for the **17 Agentic Remote Tools** in the Krix MCP toolset. These tools operate directly against GitHub repositories over the API, enabling context setup, repository discovery, code inspection, AST parsing, surgical editing, atomic commits, and Pull Request management.

---

## Tool Index

1. [`set_active_context`](#1-set_active_context)
2. [`get_me`](#2-get_me)
3. [`search_repositories`](#3-search_repositories)
4. [`list_branches`](#4-list_branches)
5. [`create_branch`](#5-create_branch)
6. [`delete_branch`](#6-delete_branch)
7. [`git_tree`](#7-git_tree)
8. [`view_file_outline`](#8-view_file_outline)
9. [`grep`](#9-grep)
10. [`search_code`](#10-search_code)
11. [`get_file_contents`](#11-get_file_contents)
12. [`str_replace_editor`](#12-str_replace_editor)
13. [`patch_contents`](#13-patch_contents)
14. [`create_or_update_file`](#14-create_or_update_file)
15. [`delete_file`](#15-delete_file)
16. [`push_files`](#16-push_files)
17. [`create_pull_request`](#17-create_pull_request)

---

## 1. `set_active_context`

### Purpose & Overview
Establishes default session-level configuration for GitHub repository metadata (`owner`, `repo`, `branch`) and local sandbox defaults (`cwd`, `env`). Calling this at session initialization ensures subsequent tools automatically inherit these context parameters without needing explicit repetition.

### Schema & Parameters
- `owner` (string, optional): GitHub username or organization name.
- `repo` (string, optional): Target repository name.
- `branch` (string, optional): Default branch name (e.g. `main`, `develop`, `feature/v2`).
- `cwd` (string, optional): Default working directory path in the sandbox environment.
- `env` (object, optional): Key-value pair object representing persistent environment variables merged into sandbox execution calls.

### Usage Example
```json
{
  "owner": "octocat",
  "repo": "hello-world",
  "branch": "main",
  "cwd": "/working_dir/projects/hello-world",
  "env": {
    "NODE_ENV": "development",
    "PORT": "3000"
  }
}
```

### Best Practices & Rules
- **Session Initialization Requirement**: Always run `set_active_context` as the very first step when starting work on a repository.
- Avoid passing conflicting `owner`/`repo` arguments in individual tool calls unless intentionally targeting a different repository.

---

## 2. `get_me`

### Purpose & Overview
Retrieves profile metadata for the authenticated GitHub identity.

### Schema & Parameters
- Takes no parameters (`{}`).

### Return Fields
- Returns `login` (GitHub handle), `name`, `email`, and account permissions.

### Usage Example
```json
{}
```

### Best Practices & Rules
- Use to verify authenticated user credentials before creating branches, opening PRs, or assigning reviewers.

---

## 3. `search_repositories`

### Purpose & Overview
Discovers and filters GitHub repositories accessible to the user using text queries, regex filtering, or exact string matching.

### Schema & Parameters
- `q` (string, optional): Search query keywords.
- `username` (string, optional): Scope search to a specific user or organization.
- `exact` (boolean, optional): Set to `true` to return only the single best-matching repository.
- `regex` (string, optional): Regular expression pattern to filter repository names.
- `page` (number, optional): Page number (1-indexed).
- `limit` (number, optional, max 20): Results per page.

### Usage Example
```json
{
  "q": "react-components",
  "exact": true
}
```

### Best Practices & Rules
- Set `exact: true` when looking up a known repository name to reduce result noise.

---

## 4. `list_branches`

### Purpose & Overview
Lists remote branches for the active or specified repository.

### Schema & Parameters
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `limit` (number, optional): Maximum number of branches to retrieve.

### Usage Example
```json
{
  "limit": 50
}
```

### Best Practices & Rules
- Always run `list_branches` before creating a new feature branch to verify branch name availability and avoid naming collisions.

---

## 5. `create_branch`

### Purpose & Overview
Creates a new remote branch in the repository originating from a specified commit SHA, branch, or tag reference.

### Schema & Parameters
- `branch` (string, required): Name of the new branch to create.
- `refSha` (string, required): Commit SHA (full 40-char or short SHA) or source branch/tag name (e.g., `main`).
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "branch": "feat/authentication-v2",
  "refSha": "main"
}
```

### Best Practices & Rules
- Use descriptive branch naming conventions like `feat/<description>`, `fix/<issue-id>`, or `refactor/<target>`.

---

## 6. `delete_branch`

### Purpose & Overview
Deletes a remote branch from the GitHub repository.

### Schema & Parameters
- `branch` (string, required): Branch name to delete.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "branch": "fix/temp-patch"
}
```

### Best Practices & Rules
- Never delete standard base branches (`main`, `master`, `develop`). Ensure feature branches are merged before deletion.

---

## 7. `git_tree`

### Purpose & Overview
Recursively retrieves the directory and file tree index for the repository without downloading full file contents.

### Schema & Parameters
- `tree_sha` (string, optional): Tree SHA, commit SHA, or branch name (defaults to default branch HEAD).
- `q` (string, optional): Query substring to filter returned file paths.
- `limit` (number, optional): Max paths per response page.
- `offset` (number, optional): Pagination offset.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "q": "src/controllers",
  "limit": 100
}
```

### Best Practices & Rules
- Use `git_tree` for initial codebase discovery and mapping directory layouts before reading individual files.

---

## 8. `view_file_outline`

### Purpose & Overview
Parses source code files to extract high-level AST (Abstract Syntax Tree) symbols, including classes, methods, interface definitions, and exported functions.

### Schema & Parameters
- `path` (string, required): File path relative to repo root (e.g., `src/utils/math.ts`).
- `ref` (string, optional): Branch or commit SHA.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "path": "src/services/UserService.ts"
}
```

### Best Practices & Rules
- Call `view_file_outline` before editing large source files to map out class structures and function signatures without pulling hundreds of code lines into context.

---

## 9. `grep`

### Purpose & Overview
Executes high-performance pattern matching across repository files with context lines, file globbing, and file type filtering.

### Schema & Parameters
- `pattern` (string, required): Regex or string pattern to search.
- `glob` (string, optional): Glob pattern filter (e.g., `src/**/*.ts`).
- `type` (string, optional): Extension filter (e.g. `ts`, `py`, `go`).
- `case_insensitive` (boolean, optional): Enable case-insensitive search.
- `context_before` (number, optional): Lines of context before match.
- `context_after` (number, optional): Lines of context after match.
- `output_mode` (enum: `content`, `files_with_matches`, `count`).
- `show_line_numbers` (boolean, optional, default true).
- `limit` / `offset` (numbers, optional).

### Usage Example
```json
{
  "pattern": "connectDatabase",
  "type": "ts",
  "context_before": 2,
  "context_after": 2,
  "output_mode": "content"
}
```

### Best Practices & Rules
- Use `output_mode: "files_with_matches"` first to identify affected files across large codebases, then switch to `"content"` with `context_before`/`context_after` for detailed inspection.

---

## 10. `search_code`

### Purpose & Overview
Performs code searches across GitHub repositories using GitHub search syntax.

### Schema & Parameters
- `q` (string, required): Search query string (e.g. `repo:octocat/hello-world symbol_name` or `extension:py import numpy`).
- `limit` (number, optional).
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "q": "repo:octocat/hello-world JWT_SECRET",
  "limit": 10
}
```

### Best Practices & Rules
- Qualify queries with `repo:` to scope searches specifically to the active repository.

---

## 11. `get_file_contents`

### Purpose & Overview
Fetches raw contents or a specific line range window from a repository file.

### Schema & Parameters
- `path` (string, required): File path.
- `startLine` (number, optional): 1-indexed start line.
- `endLine` (number, optional): 1-indexed end line.
- `limit` (number, optional, default 100, max 500 lines).
- `ref` (string, optional): Branch or commit SHA.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "path": "src/server.ts",
  "startLine": 45,
  "endLine": 95
}
```

### Best Practices & Rules
- Always use `startLine` and `endLine` windowing when inspecting large files to avoid blowing up context token limits.

---

## 12. `str_replace_editor`

### Purpose & Overview
Performs precise block string search and replacement in a file and commits the updated file directly to the target branch.

### Schema & Parameters
- `path` (string, required): Target file path.
- `message` (string, required): Commit message.
- `old_str` (string, optional): Exact block of text to replace (must match file content exactly once).
- `old_str_b64` (string, optional): Base64 encoded string for binary/multiline safety.
- `new_str` (string, optional): Replacement block of text.
- `new_str_b64` (string, optional): Base64 encoded replacement string.
- `branch` (string, optional): Target branch.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "path": "src/config.ts",
  "message": "refactor: update default API timeout to 5000ms",
  "old_str": "export const TIMEOUT = 3000;",
  "new_str": "export const TIMEOUT = 5000;",
  "branch": "feat/api-timeout"
}
```

### Best Practices & Rules
- Ensure `old_str` contains enough surrounding lines to guarantee a unique match within the file.
- Prefer `str_replace_editor` over complete file overwrites to prevent accidental code erasure.

---

## 13. `patch_contents`

### Purpose & Overview
Directly replaces a specific line range (1-indexed) in a file with new content and commits the change.

### Schema & Parameters
- `path` (string, required): File path.
- `startLine` (number, required): 1-indexed start line.
- `endLine` (number, required): 1-indexed end line.
- `newContent` (string, optional): New text to insert in place of the line range.
- `newContent_b64` (string, optional): Base64 encoded content.
- `message` (string, required): Commit message.
- `branch` (string, optional): Target branch.

### Usage Example
```json
{
  "path": "src/routes.ts",
  "startLine": 20,
  "endLine": 25,
  "newContent": "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
  "message": "fix: simplify health check route"
}
```

### Best Practices & Rules
- Verify exact line bounds with `get_file_contents` immediately before executing `patch_contents`.

---

## 14. `create_or_update_file`

### Purpose & Overview
Creates a new file or completely overwrites an existing file in the remote repository.

### Schema & Parameters
- `path` (string, required): Target file path.
- `message` (string, required): Commit message.
- `content` (string, optional): Full file text.
- `content_b64` (string, optional): Base64 encoded file content.
- `sha` (string, optional): Blob SHA of the file being updated (required when updating an existing file).
- `branch` (string, optional).

### Usage Example
```json
{
  "path": "docs/architecture.md",
  "message": "docs: add architecture overview document",
  "content": "# System Architecture\n\nThis document describes system design...",
  "branch": "main"
}
```

### Best Practices & Rules
- Provide `sha` when updating existing files to enforce optimistic concurrency and prevent overwriting concurrent updates.

---

## 15. `delete_file`

### Purpose & Overview
Deletes a file from the GitHub repository and commits the deletion.

### Schema & Parameters
- `path` (string, required): File path to delete.
- `message` (string, required): Commit message.
- `sha` (string, required): Blob SHA of the file being deleted.
- `branch` (string, required): Target branch.

### Usage Example
```json
{
  "path": "src/deprecated-service.ts",
  "message": "refactor: remove deprecated service module",
  "sha": "a1b2c3d4e5f67890123456789abcdef012345678",
  "branch": "main"
}
```

### Best Practices & Rules
- Fetch the file blob SHA using `get_file_contents` or `git_tree` before calling `delete_file`.

---

## 16. `push_files`

### Purpose & Overview
Batch pushes multiple file creations, modifications, or replacements in a single atomic commit.

### Schema & Parameters
- `branch` (string, required): Target branch.
- `message` (string, required): Commit message.
- `files` (array of objects, required): List of files to update, where each object contains:
  - `path` (string, required): File path.
  - `content` (string, required): File content text.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "branch": "feat/user-module",
  "message": "feat: add user controller, service, and data models",
  "files": [
    {
      "path": "src/user/user.controller.ts",
      "content": "export class UserController { ... }"
    },
    {
      "path": "src/user/user.service.ts",
      "content": "export class UserService { ... }"
    },
    {
      "path": "src/user/user.model.ts",
      "content": "export interface User { id: string; name: string; }"
    }
  ]
}
```

### Best Practices & Rules
- Use `push_files` whenever refactoring or adding feature modules across multiple files to ensure the commit remains atomic.

---

## 17. `create_pull_request`

### Purpose & Overview
Opens a new Pull Request on GitHub to merge changes from a feature branch into a base branch.

### Schema & Parameters
- `title` (string, required): Pull Request title.
- `head` (string, required): Feature branch containing the commits.
- `base` (string, optional, default `main`): Target branch to merge into.
- `body` (string, optional): PR description detailing purpose, changes, testing instructions, and issue links.
- `owner` / `repo` (strings, optional).

### Usage Example
```json
{
  "title": "feat: implement JWT authentication and token refresh",
  "head": "feat/jwt-auth",
  "base": "main",
  "body": "## Summary\n- Implemented JWT token sign and verify middleware.\n- Added refresh token endpoint.\n- Included unit tests in `test/auth.spec.ts`."
}
```

### Best Practices & Rules
- Ensure all tests pass in the sandbox environment before opening a Pull Request. Include concise descriptions and test proof in the `body`.

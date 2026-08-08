# Krix MCP Sandbox Tools Guide (Execution & Local Synchronization)

This reference guide provides exhaustive documentation for the **14 Sandbox & Local Synchronization Tools** in the Krix MCP toolset. These tools provide an isolated containerized environment for executing code, running build tools and test suites, managing background servers, manipulating sandbox files safely, and synchronizing changes with remote GitHub repositories via local Git operations.

---

## Tool Index

1. [`sandbox_status`](#1-sandbox_status)
2. [`sandbox_run`](#2-sandbox_run)
3. [`sandbox_exec`](#3-sandbox_exec)
4. [`sandbox_install`](#4-sandbox_install)
5. [`sandbox_ps`](#5-sandbox_ps)
6. [`sandbox_output`](#6-sandbox_output)
7. [`sandbox_file`](#7-sandbox_file)
8. [`sandbox_reset`](#8-sandbox_reset)
9. [`git_clone`](#9-git_clone)
10. [`git_checkout`](#10-git_checkout)
11. [`git_pull`](#11-git_pull)
12. [`git_status`](#12-git_status)
13. [`git_diff`](#13-git_diff)
14. [`git_commit_push`](#14-git_commit_push)

---

## 1. `sandbox_status`

### Purpose & Overview
Inspects the local sandbox container health, active runtimes (Node.js, Python, Go, Rust, Java, GCC), memory/disk usage, active cloned repository path, and active background shell processes.

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

### Best Practices & Rules
- Run `sandbox_status` before initiating complex builds or long-running scripts to confirm runtime availability and memory limits.

---

## 2. `sandbox_run`

### Purpose & Overview
Executes code snippets inline or runs existing source files directly across various language runtimes without needing manual shell execution wrappers.

### Supported Languages
`py` (Python), `js` (JavaScript), `ts` (TypeScript), `sh` (Shell), `go` (Go), `java` (Java), `cpp` (C++), `c` (C), `rust` (Rust), `ruby` (Ruby), `php` (PHP).

### Schema & Parameters
- `code` (string, optional): Inline source code snippet to execute.
- `lang` (enum, optional): Language identifier (e.g., `py`, `ts`, `js`).
- `filePath` (string, optional): Path to existing script/source file in sandbox.
- `args` (array of strings, optional): Command line arguments to pass to script.
- `dir` (string, optional): Execution working directory.

### Usage Example
```json
{
  "lang": "ts",
  "code": "import { calculateTotal } from './src/calculator'; console.log(calculateTotal([10, 20, 30]));",
  "dir": "/working_dir/projects/app"
}
```

### Best Practices & Rules
- Use `sandbox_run` for rapid prototyping, snippet testing, or executing standalone test scripts.

---

## 3. `sandbox_exec`

### Purpose & Overview
Executes arbitrary bash shell commands inside the sandbox environment. Supports stateful persistent shells, background process execution, custom working directories, and timeout controls.

### Schema & Parameters
- `command` (string, required): Shell command string.
- `persistent` (boolean, optional, default true): Maintains working directory (`cd`) and environment exports (`export KEY=val`) across subsequent tool calls. Set `persistent: false` for isolated one-off execution.
- `dir` (string, optional): Working directory for execution.
- `background` (boolean, optional): Runs command as a detached background process (monitored via `sandbox_ps`).
- `timeoutMs` (number, optional): Maximum execution time before aborting (default 60000ms).

### Usage Example
```json
{
  "command": "npm test -- --coverage",
  "dir": "/working_dir/projects/app",
  "timeoutMs": 120000
}
```

### Best Practices & Rules
- Set `background: true` when starting dev servers, database containers, or long-running test watchers.
- **Offline Constraint**: Remember the sandbox container has NO outbound internet access. Calls to `npm install` or `pip install` operate against local offline caches.

---

## 4. `sandbox_install`

### Purpose & Overview
Installs `npm` or `pip` dependencies locally into the sandbox project workspace.

### Schema & Parameters
- `manager` (enum: `npm` or `pip`, required): Package manager.
- `packages` (array of strings, required): List of package names to install.
- `dir` (string, optional): Target project directory.

### Usage Example
```json
{
  "manager": "npm",
  "packages": ["jest", "ts-jest", "@types/jest"],
  "dir": "/working_dir/projects/app"
}
```

### Best Practices & Rules
- Execute `sandbox_install` before running test runners or build commands if external libraries are missing.

---

## 5. `sandbox_ps`

### Purpose & Overview
Lists, monitors, inspects stdout/stderr output, or terminates background processes started via `sandbox_exec(background: true)`.

### Schema & Parameters
- `action` (enum: `list`, `kill`, `output`, optional):
  - `list`: Returns active background process table (PIDs, commands, status).
  - `kill`: Aborts process by PID or `"all"`.
  - `output`: Returns captured stdout/stderr for specified process.
- `pid` (number or string, optional): Target process ID.
- `offset` (number, optional): Char offset for paginating logs.
- `limit` (number, optional): Max log characters to return.

### Usage Example
```json
{
  "action": "output",
  "pid": 14205,
  "limit": 10000
}
```

### Best Practices & Rules
- Check process output periodically with `sandbox_ps(action: "output")` when running background web servers or test suites. Always terminate background processes with `sandbox_ps(action: "kill")` when finished.

---

## 6. `sandbox_output`

### Purpose & Overview
Pages through truncated output streams resulting from previous calls to `sandbox_exec`, `sandbox_run`, or `sandbox_install`.

### Schema & Parameters
- `outputId` (string, required): Output identifier extracted from the truncation notice.
- `offset` (number, optional, default 0): Starting character offset.
- `limit` (number, optional, default 100000): Maximum character length to return.

### Usage Example
```json
{
  "outputId": "out_982347123_abc",
  "offset": 100000,
  "limit": 50000
}
```

### Best Practices & Rules
- Use `sandbox_output` when test output or build logs exceed single-response size limits.

---

## 7. `sandbox_file`

### Purpose & Overview
Provides binary-safe and structure-preserving file operations (`read`, `write`, `append`, `edit`, `delete`) on the sandbox filesystem without risking shell escaping or quoting errors.

### Schema & Parameters
- `action` (enum: `read`, `write`, `append`, `edit`, `delete`, required).
- `path` (string, required): Absolute or relative file path in sandbox.
- `content` (string, optional): Text content for `write` or `append`.
- `old_str` (string, optional): Target exact string block to find (required for `edit`).
- `new_str` (string, optional): Replacement string (required for `edit`).
- `offset` / `limit` (numbers, optional): Pagination parameters for `read`.
- `dir` (string, optional): Root target directory.

### Usage Example
```json
{
  "action": "edit",
  "path": "src/server.ts",
  "old_str": "const PORT = 3000;",
  "new_str": "const PORT = process.env.PORT || 8080;"
}
```

### Best Practices & Rules
- Prefer `sandbox_file` over shell commands like `cat`, `echo`, or `sed` when reading or writing local files to avoid syntax truncation and shell expansion bugs.

---

## 8. `sandbox_reset`

### Purpose & Overview
Performs a full environment wipe: deletes temporary scratch files, removes cloned repositories, kills active background processes, and clears persistent shell state.

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

### Best Practices & Rules
- Call `sandbox_reset` when switching to a completely new, unrelated coding project or workspace task to guarantee clean state.

---

## 9. `git_clone`

### Purpose & Overview
Clones the active or specified GitHub repository into the local sandbox environment.

### Schema & Parameters
- `owner` (string, optional): Repository owner (defaults to session active context).
- `repo` (string, optional): Repository name (defaults to session active context).
- `branch` (string, optional): Target branch to clone.
- `depth` (number, optional): Shallow clone depth (e.g. `1`).

### Usage Example
```json
{
  "branch": "main",
  "depth": 1
}
```

### Best Practices & Rules
- Run `git_clone` when local code execution, building, or test suite execution is required.

---

## 10. `git_checkout`

### Purpose & Overview
Switches branches or creates a new branch in the locally cloned sandbox repository. Automatically fetches origin references if the target branch is not yet tracked locally.

### Schema & Parameters
- `branch` (string, required): Branch name to checkout.
- `create` (boolean, optional): Set `true` to create a new branch (`git checkout -b`).

### Usage Example
```json
{
  "branch": "feat/refactor-router",
  "create": true
}
```

### Best Practices & Rules
- Ensure uncommitted changes are stashed or committed before switching branches to avoid merge conflicts.

---

## 11. `git_pull`

### Purpose & Overview
Fast-forward pulls the latest commits from origin into the current local branch of the cloned sandbox repo.

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

### Best Practices & Rules
- Call `git_pull` before starting new edits to ensure working tree contains latest remote commits.

---

## 12. `git_status`

### Purpose & Overview
Displays compact local working tree status (current branch, staged changes, modified files, untracked files).

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

### Best Practices & Rules
- Check `git_status` before committing or pushing to ensure no unintended scratch files are staged.

---

## 13. `git_diff`

### Purpose & Overview
Generates patch diffs for unstaged or staged changes in the local cloned sandbox repository.

### Schema & Parameters
- `path` (string, optional): Scope diff to a specific file or directory.
- `staged` (boolean, optional): If `true`, returns diff of staged changes (`git diff --staged`).

### Usage Example
```json
{
  "path": "src/controllers/authController.ts",
  "staged": false
}
```

### Best Practices & Rules
- Review `git_diff` outputs to verify code formatting and correctness before creating commits.

---

## 14. `git_commit_push`

### Purpose & Overview
Stages all modified/untracked files (`git add -A`), creates a Git commit, and pushes the branch to origin.

### Schema & Parameters
- `message` (string, required): Git commit message following conventional commits style.
- `push` (boolean, optional, default true): Automatically push to origin after committing.
- `branch` (string, optional): Branch to push.

### Usage Example
```json
{
  "message": "fix(auth): fix token expiration handling in auth middleware",
  "push": true
}
```

### Best Practices & Rules
- Use meaningful, standardized commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`).

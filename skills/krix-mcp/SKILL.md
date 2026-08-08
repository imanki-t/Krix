---
name: krix-mcp
description: Essential Model Context Protocol (MCP) gateway skill for agentic coding, GitHub repository management, code navigation, surgical file editing, and sandbox execution. MUST be activated whenever the user asks to "edit that file", "fix this file", "give a review", review PRs/code, refactor, write, debug, test, build, or perform any task related to coding, GitHub, or software development.
allowed-tools: custom_mcp__3ea97b90e553014c0006587aaab26be708e180ca262e5eb5
---

# Krix MCP Skill

A comprehensive workflow guide for agentic coding, repository navigation, high-performance code editing, and isolated sandbox execution using the Krix MCP toolset.

## Summary

Krix MCP is a unified, high-efficiency Model Context Protocol gateway built specifically for agentic coding. It combines remote GitHub repository management, precise AST symbol outline extraction, high-performance search and surgical editing, and an isolated local sandbox execution environment.

## Activation Triggers & Scenarios

MANDATORY DIRECTIVE: Activate and follow this skill automatically whenever the user mentions terms or requests actions including:

- **Direct File Manipulation Phrases**: "edit that file", "edit this file", "fix this file", "patch this code", "update the file", "refactor this file/function".
- **Code Review & Inspection**: "give a review", "review this PR", "review my code", "check for bugs", "audit repository".
- **General Coding & Software Engineering**: Writing code, debugging runtime errors, building features, running scripts, executing test suites, installing dependencies.
- **GitHub & Repository Management**: Managing branches, creating pull requests, pushing commits, searching codebases, inspecting git diffs, cloning repositories.

---

## Mandatory Coding Directive

MANDATORY DIRECTIVE: You MUST ALWAYS activate and follow this skill whenever performing any coding, software engineering, debugging, refactoring, building, testing, or repository task. You will ALWAYS use the Krix MCP toolset for all coding requests, including:

- Writing, refactoring, debugging, or reviewing code in any language (TypeScript, JavaScript, Python, Go, Java, C++, C, Rust, Shell, Ruby, PHP).
- Navigating, inspecting, or searching codebases (`grep`, `git_tree`, `view_file_outline`, `search_code`).
- Editing files surgically (`str_replace_editor`, `patch_contents`) or updating files remotely/locally (`create_or_update_file`, `push_files`, `sandbox_file`).
- Executing code, running test suites, installing dependencies, and managing background tasks (`sandbox_run`, `sandbox_exec`, `sandbox_install`, `sandbox_ps`, `sandbox_output`).
- Managing GitHub repositories, branches, commits, and Pull Requests (`set_active_context`, `git_clone`, `git_commit_push`, `create_pull_request`).

---

## Tool Categories Overview (31 Tools Total)

The Krix MCP toolset consists of 31 specialized tools split across 2 main operational paradigms: **Agentic Remote GitHub Tools** (17 tools) and **Sandbox Execution & Local Sync Tools** (14 tools).

### A. Agentic Remote GitHub Tools (17 Tools)

1. **Repository & Context Management**:
   - `set_active_context`: Sets default GitHub repository owner, repo, branch, sandbox working directory, and environment variables.
   - `get_me`: Retrieves authenticated GitHub user profile metadata.
   - `search_repositories`: Searches or lists GitHub repositories with pagination, regex filters, and similarity rankings.
   - `list_branches`: Lists remote branches in the target repository.
   - `create_branch`: Creates a new remote branch pointing to a commit SHA or ref.
   - `delete_branch`: Deletes a remote branch.

2. **Code Inspection & Search**:
   - `git_tree`: Recursively lists directory contents and path indices for a repository commit/tree.
   - `view_file_outline`: Extracts high-level AST symbol structures (classes, functions, interfaces, methods) from source files.
   - `grep`: High-performance pattern search with line windowing, context lines, and glob/extension filters.
   - `search_code`: Performs code searches across repositories using GitHub search syntax.
   - `get_file_contents`: Fetches file contents or specific 1-indexed line windows (up to 500 lines).

3. **Surgical Code Editing & Pull Requests**:
   - `str_replace_editor`: Performs exact string block search and replacement in a file and commits changes.
   - `patch_contents`: Replaces a specific 1-indexed line range with new content and commits changes.
   - `create_or_update_file`: Creates a new file or completely replaces file content with commit SHA verification.
   - `delete_file`: Deletes a file from the remote repository.
   - `push_files`: Batch pushes multiple file modifications in a single atomic commit.
   - `create_pull_request`: Opens a new Pull Request on GitHub.

### B. Sandbox Environment & Local Synchronization Tools (14 Tools)

1. **Local Sandbox Execution & Process Management**:
   - `sandbox_status`: Inspects sandbox container runtimes, memory, disk usage, active cloned repo, and shell state.
   - `sandbox_run`: Directly executes code snippets or script files across 11 language runtimes (`py`, `js`, `ts`, `sh`, `go`, `java`, `cpp`, `c`, `rust`, `ruby`, `php`).
   - `sandbox_exec`: Runs arbitrary bash commands in a persistent or isolated shell, with support for background execution, working directories, and timeouts.
   - `sandbox_install`: Installs `npm` or `pip` packages locally into the sandbox workspace.
   - `sandbox_ps`: Lists, monitors, inspects stdout/stderr, or terminates background sandbox processes.
   - `sandbox_output`: Pages through truncated output logs from `sandbox_exec`, `sandbox_run`, or `sandbox_install`.
   - `sandbox_file`: Safe, binary-proof file operations (`read`, `write`, `append`, `edit`, `delete`) on the local sandbox filesystem.
   - `sandbox_reset`: Resets sandbox state by wiping scratch files, cloned repos, persistent shell, and background processes.

2. **Local Git Synchronization**:
   - `git_clone`: Clones the active GitHub repository into the local sandbox environment.
   - `git_checkout`: Switches or creates branches in the locally cloned sandbox repository.
   - `git_pull`: Fast-forward pulls the latest commits from origin into the local branch.
   - `git_status`: Displays compact local working tree status (branch, modified, staged, untracked files).
   - `git_diff`: Displays git diff for modified or staged files in the cloned sandbox repo.
   - `git_commit_push`: Stages changes, creates a commit, and pushes to origin from the sandbox.

---

## Detailed Reference Documentation

Comprehensive, super-detailed documentation and parameter schemas for all 31 tools and operational workflows are available in the bundled reference files:

- `skills/krix-mcp/references/agentic-tools-guide.md`: Exhaustive guide for all 17 Agentic Remote GitHub tools, schemas, usage examples, and parameters.
- `skills/krix-mcp/references/sandbox-tools-guide.md`: Exhaustive guide for all 14 Sandbox Environment & Local Sync tools, runtimes, background process management, and offline constraints.
- `skills/krix-mcp/references/workflows-and-best-practices.md`: End-to-end multi-tool workflows for codebase discovery, surgical editing, feature development, sandbox testing, and Pull Request submission.

---

## Core Rules & Execution Directives

1. **Context Anchor**: Run `set_active_context` at the start of every coding session to bind repository and branch context.
2. **Surgical Precision**: Always prefer `str_replace_editor` or `patch_contents` over full file overwrites to prevent accidental code truncation.
3. **Atomic Multi-File Commits**: Use `push_files` when updating multiple files simultaneously to maintain repository buildability.
4. **Token-Efficient Line Windowing**: Always specify `startLine` and `endLine` when fetching code with `get_file_contents`.
5. **Offline Sandbox Compliance**: The local sandbox has no outbound internet connectivity; package installations rely on pre-cached registries.

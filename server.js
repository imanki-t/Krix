import express from "express";
import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Optional shared secret to stop randoms from hitting your hosted MCP endpoint.
// If set, requests must send: Authorization: Bearer <MCP_AUTH_TOKEN>
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;
// Fallback PAT if a caller doesn't supply their own GitHub token.
const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
// Optional: for GitHub Enterprise Server, e.g. https://github.mycompany.com/api/v3
const GITHUB_BASE_URL = process.env.GITHUB_BASE_URL || undefined;

function getOctokit(githubToken) {
  const auth = githubToken || DEFAULT_GITHUB_PAT;
  if (!auth) {
    throw new Error(
      "No GitHub token available. Set GITHUB_PERSONAL_ACCESS_TOKEN on the server, " +
        "or pass one per-request via the X-GitHub-Token header."
    );
  }
  return new Octokit({ auth, baseUrl: GITHUB_BASE_URL });
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Build one MCP server instance bound to a specific GitHub token (per request)
// ---------------------------------------------------------------------------
function buildServer(githubToken) {
  const server = new McpServer({
    name: "github-mcp-server-custom",
    version: "1.0.0",
  });

  server.registerTool(
    "list_repos",
    {
      title: "List Repositories",
      description: "List repositories for the authenticated user.",
      inputSchema: {
        type: z.enum(["all", "owner", "member"]).default("owner").describe("Repo filter type"),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ type, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.listForAuthenticatedUser({ type, per_page });
        return textResult(
          data.map((r) => ({ full_name: r.full_name, private: r.private, url: r.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_repo",
    {
      title: "Get Repository",
      description: "Get details about a single repository.",
      inputSchema: {
        owner: z.string().describe("Repository owner (user or org)"),
        repo: z.string().describe("Repository name"),
      },
    },
    async ({ owner, repo }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.get({ owner, repo });
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_repos",
    {
      title: "Search Repositories",
      description: "Search GitHub repositories by query string.",
      inputSchema: {
        query: z.string().describe("GitHub search query, e.g. 'mcp language:typescript'"),
        per_page: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.search.repos({ q: query, per_page });
        return textResult(
          data.items.map((r) => ({ full_name: r.full_name, description: r.description, stars: r.stargazers_count, url: r.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_issues",
    {
      title: "List Issues",
      description: "List issues for a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).default("open"),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ owner, repo, state, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.issues.listForRepo({ owner, repo, state, per_page });
        return textResult(
          data.map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create Issue",
      description: "Create a new issue in a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ owner, repo, title, body, labels }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.issues.create({ owner, repo, title, body, labels });
        return textResult({ number: data.number, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "add_issue_comment",
    {
      title: "Add Issue Comment",
      description: "Add a comment to an existing issue or pull request.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().int(),
        body: z.string(),
      },
    },
    async ({ owner, repo, issue_number, body }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.issues.createComment({ owner, repo, issue_number, body });
        return textResult({ id: data.id, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_pull_requests",
    {
      title: "List Pull Requests",
      description: "List pull requests for a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).default("open"),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ owner, repo, state, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.list({ owner, repo, state, per_page });
        return textResult(
          data.map((p) => ({ number: p.number, title: p.title, state: p.state, url: p.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_pull_request",
    {
      title: "Create Pull Request",
      description: "Open a new pull request.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        head: z.string().describe("Branch with your changes, e.g. 'feature-x' or 'user:feature-x'"),
        base: z.string().describe("Branch you want to merge into, e.g. 'main'"),
        body: z.string().optional(),
      },
    },
    async ({ owner, repo, title, head, base, body }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body });
        return textResult({ number: data.number, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Get Pull Request",
      description: "Get full details of a single pull request (description, branches, mergeable state, etc).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int(),
      },
    },
    async ({ owner, repo, pull_number }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.get({ owner, repo, pull_number });
        return textResult({
          number: data.number,
          title: data.title,
          state: data.state,
          body: data.body,
          head: data.head.ref,
          base: data.base.ref,
          mergeable: data.mergeable,
          merged: data.merged,
          draft: data.draft,
          url: data.html_url,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_pull_request_files",
    {
      title: "List Pull Request Files",
      description: "List the files changed in a pull request, including per-file diffs (patches).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int(),
        per_page: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ owner, repo, pull_number, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page });
        return textResult(
          data.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "update_pull_request",
    {
      title: "Update Pull Request",
      description: "Edit a pull request's title, body, state, or base branch.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        base: z.string().optional(),
      },
    },
    async ({ owner, repo, pull_number, title, body, state, base }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.update({ owner, repo, pull_number, title, body, state, base });
        return textResult({ number: data.number, state: data.state, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "merge_pull_request",
    {
      title: "Merge Pull Request",
      description: "Merge a pull request.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int(),
        merge_method: z.enum(["merge", "squash", "rebase"]).default("merge"),
        commit_title: z.string().optional(),
        commit_message: z.string().optional(),
      },
    },
    async ({ owner, repo, pull_number, merge_method, commit_title, commit_message }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.merge({
          owner,
          repo,
          pull_number,
          merge_method,
          commit_title,
          commit_message,
        });
        return textResult({ merged: data.merged, sha: data.sha, message: data.message });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_pull_request_review",
    {
      title: "Create Pull Request Review",
      description: "Submit a review on a pull request (approve, request changes, or comment).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int(),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
        body: z.string().optional(),
      },
    },
    async ({ owner, repo, pull_number, event, body }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.pulls.createReview({ owner, repo, pull_number, event, body });
        return textResult({ id: data.id, state: data.state });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_file_contents",
    {
      title: "Get File Contents",
      description: "Read a file's contents from a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional().describe("Branch, tag, or commit SHA"),
      },
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
        if (Array.isArray(data)) {
          return textResult(data.map((f) => ({ name: f.name, type: f.type, path: f.path })));
        }
        const content = Buffer.from(data.content, data.encoding).toString("utf-8");
        return textResult(content);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_or_update_file",
    {
      title: "Create or Update File",
      description: "Create a new file or update an existing one with a commit.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        content: z.string().describe("Raw file content (not base64-encoded)"),
        message: z.string().describe("Commit message"),
        branch: z.string().optional(),
        sha: z.string().optional().describe("Required when updating an existing file"),
      },
    },
    async ({ owner, repo, path, content, message, branch, sha }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, "utf-8").toString("base64"),
          branch,
          sha,
        });
        return textResult({ commit: data.commit.sha, url: data.content.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Delete a file from a repository (creates a commit).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        message: z.string().describe("Commit message"),
        sha: z.string().describe("Blob SHA of the file being deleted (get it from get_file_contents)"),
        branch: z.string().optional(),
      },
    },
    async ({ owner, repo, path, message, sha, branch }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.deleteFile({ owner, repo, path, message, sha, branch });
        return textResult({ commit: data.commit.sha });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_branch",
    {
      title: "Create Branch",
      description: "Create a new branch from an existing ref.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        branch: z.string().describe("Name of the new branch"),
        from_branch: z.string().optional().describe("Source branch (defaults to repo default branch)"),
      },
    },
    async ({ owner, repo, branch, from_branch }) => {
      try {
        const octokit = getOctokit(githubToken);
        const repoData = await octokit.repos.get({ owner, repo });
        const base = from_branch || repoData.data.default_branch;
        const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
        const { data } = await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: baseRef.data.object.sha,
        });
        return textResult({ ref: data.ref, sha: data.object.sha });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_branches",
    {
      title: "List Branches",
      description: "List all branches in a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        per_page: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ owner, repo, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.listBranches({ owner, repo, per_page });
        return textResult(data.map((b) => ({ name: b.name, protected: b.protected, sha: b.commit.sha })));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_branch",
    {
      title: "Delete Branch",
      description: "Delete a branch from a repository.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
      },
    },
    async ({ owner, repo, branch }) => {
      try {
        const octokit = getOctokit(githubToken);
        await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
        return textResult({ deleted: branch });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_repo_tree",
    {
      title: "Get Repository Tree",
      description:
        "Get the full file/folder structure of a repository as a tree (like `git ls-tree -r`). " +
        "Useful for understanding a repo's layout before reading specific files.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        ref: z.string().optional().describe("Branch, tag, or commit SHA (defaults to the repo's default branch)"),
        recursive: z.boolean().default(true).describe("Recurse into all subdirectories"),
      },
    },
    async ({ owner, repo, ref, recursive }) => {
      try {
        const octokit = getOctokit(githubToken);
        const treeSha = ref || (await octokit.repos.get({ owner, repo })).data.default_branch;
        const { data } = await octokit.git.getTree({
          owner,
          repo,
          tree_sha: treeSha,
          recursive: recursive ? "true" : undefined,
        });
        if (data.truncated) {
          return textResult({
            truncated: true,
            note: "Tree was too large and got truncated by the GitHub API. Narrow down with a subdirectory or non-recursive calls.",
            tree: data.tree.map((t) => ({ path: t.path, type: t.type, sha: t.sha })),
          });
        }
        // Render as an indented tree string for readability
        const lines = data.tree
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((t) => {
            const depth = t.path.split("/").length - 1;
            const name = t.path.split("/").pop();
            const marker = t.type === "tree" ? `${name}/` : name;
            return `${"  ".repeat(depth)}${marker}`;
          });
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description: "Search code across GitHub.",
      inputSchema: {
        query: z.string().describe("e.g. 'useState repo:facebook/react'"),
        per_page: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.search.code({ q: query, per_page });
        return textResult(
          data.items.map((i) => ({ name: i.name, path: i.path, repo: i.repository.full_name, url: i.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_commits",
    {
      title: "List Commits",
      description: "List recent commits on a branch.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        sha: z.string().optional().describe("Branch, tag, or SHA to start listing from"),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ owner, repo, sha, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.listCommits({ owner, repo, sha, per_page });
        return textResult(
          data.map((c) => ({ sha: c.sha, message: c.commit.message.split("\n")[0], author: c.commit.author?.name, url: c.html_url }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_commit",
    {
      title: "Get Commit",
      description: "Get details and diff of a single commit.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        ref: z.string().describe("Commit SHA"),
      },
    },
    async ({ owner, repo, ref }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.getCommit({ owner, repo, ref });
        return textResult({
          sha: data.sha,
          message: data.commit.message,
          author: data.commit.author?.name,
          files: data.files?.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "compare_commits",
    {
      title: "Compare Commits/Branches",
      description: "Diff two branches, tags, or commit SHAs (e.g. to preview what a PR would contain).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        base: z.string().describe("Base branch/tag/SHA"),
        head: z.string().describe("Head branch/tag/SHA"),
      },
    },
    async ({ owner, repo, base, head }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.compareCommits({ owner, repo, base, head });
        return textResult({
          status: data.status,
          ahead_by: data.ahead_by,
          behind_by: data.behind_by,
          total_commits: data.total_commits,
          files: data.files?.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_commit_status",
    {
      title: "Get Commit CI Status",
      description: "Get combined CI/check status for a commit or branch (pass/fail/pending of all checks).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        ref: z.string().describe("Branch name, tag, or commit SHA"),
      },
    },
    async ({ owner, repo, ref }) => {
      try {
        const octokit = getOctokit(githubToken);
        const [combined, checks] = await Promise.all([
          octokit.repos.getCombinedStatusForRef({ owner, repo, ref }).catch(() => null),
          octokit.checks.listForRef({ owner, repo, ref }).catch(() => null),
        ]);
        return textResult({
          combined_state: combined?.data?.state,
          statuses: combined?.data?.statuses?.map((s) => ({ context: s.context, state: s.state, description: s.description })),
          check_runs: checks?.data?.check_runs?.map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            url: c.html_url,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_workflow_runs",
    {
      title: "List GitHub Actions Workflow Runs",
      description: "List recent GitHub Actions workflow runs for a repository, optionally filtered by branch.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
        per_page: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({ owner, repo, branch, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, branch, per_page });
        return textResult(
          data.workflow_runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            url: r.html_url,
          }))
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "trigger_workflow",
    {
      title: "Trigger GitHub Actions Workflow",
      description: "Manually trigger a workflow_dispatch run for a workflow file.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        workflow_id: z.string().describe("Workflow file name (e.g. 'ci.yml') or numeric ID"),
        ref: z.string().describe("Branch or tag to run the workflow on"),
        inputs: z.record(z.string()).optional().describe("Workflow input parameters, if any"),
      },
    },
    async ({ owner, repo, workflow_id, ref, inputs }) => {
      try {
        const octokit = getOctokit(githubToken);
        await octokit.actions.createWorkflowDispatch({ owner, repo, workflow_id, ref, inputs });
        return textResult({ triggered: true, workflow_id, ref });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update Issue",
      description: "Edit an issue's title, body, state, or labels.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ owner, repo, issue_number, title, body, state, labels }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.issues.update({ owner, repo, issue_number, title, body, state, labels });
        return textResult({ number: data.number, state: data.state, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_issue_comments",
    {
      title: "List Issue Comments",
      description: "List comments on an issue or pull request.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().int(),
        per_page: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ owner, repo, issue_number, per_page }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.issues.listComments({ owner, repo, issue_number, per_page });
        return textResult(data.map((c) => ({ id: c.id, user: c.user?.login, body: c.body, url: c.html_url })));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_repository",
    {
      title: "Create Repository",
      description: "Create a new GitHub repository for the authenticated user.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        private: z.boolean().default(false),
        auto_init: z.boolean().default(true).describe("Initialize with a README"),
      },
    },
    async ({ name, description, private: isPrivate, auto_init }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.createForAuthenticatedUser({
          name,
          description,
          private: isPrivate,
          auto_init,
        });
        return textResult({ full_name: data.full_name, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "fork_repository",
    {
      title: "Fork Repository",
      description: "Fork a repository into your account or an organization.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        organization: z.string().optional().describe("Fork into this org instead of your personal account"),
      },
    },
    async ({ owner, repo, organization }) => {
      try {
        const octokit = getOctokit(githubToken);
        const { data } = await octokit.repos.createFork({ owner, repo, organization });
        return textResult({ full_name: data.full_name, url: data.html_url });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport (stateless: one server+transport per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  // Optional gate so randoms can't call your hosted server.
  if (MCP_AUTH_TOKEN) {
    const provided = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (provided !== MCP_AUTH_TOKEN) {
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
  }

  // Per-request GitHub PAT, e.g. for multi-tenant hosting.
  // Falls back to the server's own GITHUB_PERSONAL_ACCESS_TOKEN env var.
  const githubToken = req.headers["x-github-token"];

  try {
    const server = buildServer(githubToken);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode: simplest to host/scale
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Streamable HTTP also defines GET/DELETE for sessions; not needed in stateless
// mode, but some clients probe them, so respond politely instead of 404.
app.get("/mcp", (_req, res) => res.status(405).send("Method not allowed (stateless server)"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method not allowed (stateless server)"));

app.listen(PORT, () => {
  console.log(`GitHub MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: POST http://localhost:${PORT}/mcp`);
  if (!DEFAULT_GITHUB_PAT) {
    console.warn(
      "Warning: GITHUB_PERSONAL_ACCESS_TOKEN is not set. Callers must send their own token via the X-GitHub-Token header."
    );
  }
});

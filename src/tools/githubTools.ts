import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations, resolveInputString, getSessionContext, updateSessionContext, makeRegistrar } from '../core/security.js';

function handleGitHubError(err: any): any {
  if (err?.status === 401 || err?.message?.includes('Bad credentials')) {
    return formatError(new Error("GitHub Authentication Failed (401). Please add a valid GitHub Personal Access Token (PAT) in the Krix dashboard or provide 'x-github-token' header."));
  }
  if (err?.status === 403 && err?.headers?.['x-ratelimit-remaining'] === '0') {
    const resetTime = err.headers['x-ratelimit-reset']
      ? new Date(parseInt(err.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString()
      : 'soon';
    return formatError(new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`));
  }
  if (err?.status === 404) {
    return formatError(new Error("GitHub Resource Not Found (404). Verify the owner, repository name, branch, or target file path."));
  }
  return formatError(err);
}

function resolveRepo(inputOwner: string | undefined, inputRepo: string | undefined, sessionId: string): { owner: string; repo: string } {
  const ctx = getSessionContext(sessionId);
  const owner = inputOwner || ctx.owner;
  const repo = inputRepo || ctx.repo;
  if (!owner || !repo) {
    throw new Error("Repository context not specified. Either pass 'owner' and 'repo' arguments, or call 'set_active_context' first.");
  }
  return { owner, repo };
}

function resolveBranch(inputBranch: string | undefined, sessionId: string): string | undefined {
  return inputBranch || getSessionContext(sessionId).branch;
}

function calculateLevenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function registerGitHubTools(
  server: McpServer,
  octokit: Octokit,
  sessionId: string,
  registry: Record<string, any> = {}
) {
  const register = makeRegistrar(server, registry);

  register('set_active_context', {
    description: 'Set default owner, repository, and branch context for the current session to avoid passing them repeatedly.',
    inputSchema: {
      owner: z.string().describe('Default repository owner or organization'),
      repo: z.string().describe('Default repository name'),
      branch: z.string().optional().describe('Default working branch')
    },
    annotations: getToolAnnotations('set_active_context')
  }, async (input) => {
    updateSessionContext(sessionId, {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch
    });
    return formatOptimizedResponse({
      status: 'Session context updated',
      activeContext: { owner: input.owner, repo: input.repo, branch: input.branch || '(default branch)' }
    });
  });

  register('get_me', {
    description: 'Get authenticated user profile details from GitHub.',
    inputSchema: {},
    annotations: getToolAnnotations('get_me')
  }, async () => {
    try {
      const res = await octokit.rest.users.getAuthenticated();
      return formatOptimizedResponse({
        login: res.data.login,
        id: res.data.id,
        name: res.data.name,
        email: res.data.email,
        public_repos: res.data.public_repos,
        total_private_repos: res.data.total_private_repos,
        plan: res.data.plan?.name
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('get_file_contents', {
    description: 'Get contents of a file with line numbers (windowed view supported, max 500 lines per call).',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('Path to the file'),
      ref: z.string().optional().describe('Commit, branch, or tag reference'),
      start_line: z.number().optional().describe('1-indexed starting line (default: 1)'),
      end_line: z.number().optional().describe('1-indexed ending line (max window 500 lines)')
    },
    annotations: getToolAnnotations('get_file_contents')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const ref = resolveBranch(input.ref, sessionId);
      const res = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref });

      if (Array.isArray(res.data) || res.data.type !== 'file') {
        throw new Error(`Target path '${input.path}' is a directory, not a file.`);
      }

      const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = Math.max(1, input.start_line || 1);
      const end = Math.min(totalLines, input.end_line || Math.min(start + 499, totalLines));

      if (end - start > 500) {
        throw new Error('Window size exceeds 500 lines. Please request a smaller line range.');
      }

      const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
      return formatOptimizedResponse({
        path: input.path,
        sha: res.data.sha,
        totalLines,
        range: { start, end },
        content: numbered
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('str_replace_editor', {
    description: 'Perform precise block replacement inside a file. Provides Levenshtein similarity hints if target block is not found.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('Path to the file to edit'),
      old_str: z.string().describe('Exact block of text to replace'),
      new_str: z.string().describe('Replacement text block'),
      branch: z.string().optional().describe('Branch name'),
      message: z.string().optional().describe('Commit message')
    },
    annotations: getToolAnnotations('str_replace_editor')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const branch = resolveBranch(input.branch, sessionId);
      const res = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref: branch });

      if (Array.isArray(res.data) || res.data.type !== 'file') {
        throw new Error(`Target '${input.path}' is not a file.`);
      }

      const original = Buffer.from(res.data.content, 'base64').toString('utf-8');
      const count = original.split(input.old_str).length - 1;

      if (count === 0) {
        let bestDistance = Infinity;
        let bestSnippet = '';
        const lines = original.split('\n');
        for (let i = 0; i < lines.length - 2; i++) {
          const slice = lines.slice(i, i + 3).join('\n');
          const dist = calculateLevenshtein(input.old_str.slice(0, 100), slice.slice(0, 100));
          if (dist < bestDistance) {
            bestDistance = dist;
            bestSnippet = slice;
          }
        }
        return formatError(new Error(`old_str not found in '${input.path}'. Did you mean:\n---\n${bestSnippet}\n---`));
      }

      if (count > 1) {
        return formatError(new Error(`old_str matches ${count} locations in '${input.path}'. Provide a larger, unique block of context.`));
      }

      const updated = original.replace(input.old_str, input.new_str);
      const putRes = await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path: input.path,
        message: input.message || `chore: edit ${input.path} via str_replace_editor`,
        content: Buffer.from(updated, 'utf-8').toString('base64'),
        sha: res.data.sha,
        branch
      });

      return formatOptimizedResponse({
        status: 'File updated successfully',
        path: input.path,
        commitSha: putRes.data.commit.sha
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('create_or_update_file', {
    description: 'Create a new file or completely overwrite an existing file on GitHub.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('File path'),
      content: z.string().describe('File content (UTF-8 text or Base64)'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Branch name'),
      is_base64: z.boolean().optional().describe('Set true if content is base64 encoded')
    },
    annotations: getToolAnnotations('create_or_update_file')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const branch = resolveBranch(input.branch, sessionId);
      let existingSha: string | undefined;
      try {
        const existing = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref: branch });
        if (!Array.isArray(existing.data) && existing.data.type === 'file') {
          existingSha = existing.data.sha;
        }
      } catch {}

      const b64 = input.is_base64 ? input.content : Buffer.from(input.content, 'utf-8').toString('base64');
      const res = await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path: input.path,
        message: input.message,
        content: b64,
        sha: existingSha,
        branch
      });

      return formatOptimizedResponse({
        status: existingSha ? 'File updated' : 'File created',
        path: input.path,
        commitSha: res.data.commit.sha
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('delete_file', {
    description: 'Delete a file from a repository branch on GitHub.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('Path to file to delete'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Branch name'),
      sha: z.string().optional().describe('File blob SHA (fetched automatically if omitted)')
    },
    annotations: getToolAnnotations('delete_file')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const branch = resolveBranch(input.branch, sessionId);
      let sha = input.sha;
      if (!sha) {
        const fileData = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref: branch });
        if (Array.isArray(fileData.data) || fileData.data.type !== 'file') throw new Error(`'${input.path}' is not a file.`);
        sha = fileData.data.sha;
      }

      const res = await octokit.rest.repos.deleteFile({ owner, repo, path: input.path, message: input.message, sha, branch });
      return formatOptimizedResponse({
        status: 'File deleted',
        path: input.path,
        commitSha: res.data.commit.sha
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('grep', {
    description: 'Perform server-side regex searches across repository code with glob filters.',
    inputSchema: {
      query: z.string().describe('Text or regex search query'),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().optional().describe('Subdirectory path filter')
    },
    annotations: getToolAnnotations('grep')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const fullQuery = `${input.query} repo:${owner}/${repo}${input.path ? ` path:${input.path}` : ''}`;
      const res = await octokit.rest.search.code({ q: fullQuery, per_page: 30 });

      const matches = res.data.items.map(item => ({
        path: item.path,
        html_url: item.html_url
      }));

      return formatOptimizedResponse({ totalCount: res.data.total_count, matches });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('view_file_outline', {
    description: 'Extract high-level AST symbol structures (classes, functions, interfaces, exports) without reading entire file.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('File path'),
      ref: z.string().optional().describe('Branch or commit reference')
    },
    annotations: getToolAnnotations('view_file_outline')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const ref = resolveBranch(input.ref, sessionId);
      const res = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref });

      if (Array.isArray(res.data) || res.data.type !== 'file') throw new Error('Target is not a file.');
      const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
      const lines = content.split('\n');

      const symbols: Array<{ line: number; text: string; kind: string }> = [];
      const regexPatterns = [
        { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/ },
        { kind: 'class', regex: /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/ },
        { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/ },
        { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/ },
        { kind: 'const_func', regex: /^\s*(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(/ }
      ];

      lines.forEach((line, idx) => {
        for (const { kind, regex } of regexPatterns) {
          const m = line.match(regex);
          if (m) {
            symbols.push({ line: idx + 1, text: line.trim(), kind });
            break;
          }
        }
      });

      return formatOptimizedResponse({ path: input.path, totalLines: lines.length, symbols });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('git_tree', {
    description: 'Recursively retrieve the directory and file tree of a repository with pagination.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      tree_sha: z.string().optional().describe('Tree SHA or branch name (defaults to main/master)'),
      recursive: z.boolean().optional().describe('Whether to fetch recursively (default true)'),
      offset: z.number().optional().describe('Pagination offset index'),
      limit: z.number().optional().describe('Max files to return (default: 100)')
    },
    annotations: getToolAnnotations('git_tree')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const treeSha = input.tree_sha || resolveBranch(undefined, sessionId) || 'HEAD';
      const res = await octokit.rest.git.getTree({
        owner, repo,
        tree_sha: treeSha,
        recursive: input.recursive !== false ? 'true' : undefined
      });

      const offset = input.offset || 0;
      const limit = Math.min(input.limit || 100, 300);
      const sliced = res.data.tree.slice(offset, offset + limit).map(t => ({
        path: t.path,
        type: t.type === 'blob' ? 'file' : 'dir',
        size: t.size
      }));

      return formatOptimizedResponse({
        truncated: res.data.truncated,
        totalEntries: res.data.tree.length,
        offset, limit,
        entries: sliced
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('patch_contents', {
    description: 'Replace a range of line numbers directly in a file without requiring exact multi-line string matches.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      path: z.string().describe('File path'),
      start_line: z.number().describe('1-indexed starting line to replace'),
      end_line: z.number().describe('1-indexed ending line to replace (inclusive)'),
      replacement: z.string().describe('New content to replace the line range with'),
      branch: z.string().optional().describe('Branch name'),
      message: z.string().optional().describe('Commit message')
    },
    annotations: getToolAnnotations('patch_contents')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const branch = resolveBranch(input.branch, sessionId);
      const res = await octokit.rest.repos.getContent({ owner, repo, path: input.path, ref: branch });

      if (Array.isArray(res.data) || res.data.type !== 'file') throw new Error('Target is not a file.');
      const original = Buffer.from(res.data.content, 'base64').toString('utf-8');
      const lines = original.split('\n');

      if (input.start_line < 1 || input.end_line > lines.length || input.start_line > input.end_line) {
        throw new Error(`Invalid line range: [${input.start_line}, ${input.end_line}]. File has ${lines.length} lines.`);
      }

      const repLines = input.replacement.split('\n');
      lines.splice(input.start_line - 1, input.end_line - input.start_line + 1, ...repLines);

      const updated = lines.join('\n');
      const putRes = await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path: input.path,
        message: input.message || `chore: patch ${input.path} lines ${input.start_line}-${input.end_line}`,
        content: Buffer.from(updated, 'utf-8').toString('base64'),
        sha: res.data.sha,
        branch
      });

      return formatOptimizedResponse({
        status: 'File patched',
        path: input.path,
        commitSha: putRes.data.commit.sha
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('list_branches', {
    description: 'List branches in the repository.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      per_page: z.number().optional().describe('Max branches per page (default 30)')
    },
    annotations: getToolAnnotations('list_branches')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.repos.listBranches({ owner, repo, per_page: input.per_page || 30 });
      return formatOptimizedResponse(res.data.map(b => ({ name: b.name, commitSha: b.commit.sha, protected: b.protected })));
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('create_branch', {
    description: 'Create a new branch from a commit SHA or existing branch.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      branch: z.string().describe('Name of the new branch to create'),
      from_branch: z.string().optional().describe('Base branch name (defaults to main/master)'),
      sha: z.string().optional().describe('Base commit SHA (overrides from_branch if specified)')
    },
    annotations: getToolAnnotations('create_branch')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      let targetSha = input.sha;
      if (!targetSha) {
        const baseBranch = input.from_branch || resolveBranch(undefined, sessionId) || 'main';
        const refRes = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
        targetSha = refRes.data.object.sha;
      }

      const res = await octokit.rest.git.createRef({
        owner, repo,
        ref: `refs/heads/${input.branch}`,
        sha: targetSha
      });

      return formatOptimizedResponse({ status: 'Branch created', ref: res.data.ref, sha: targetSha });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('delete_branch', {
    description: 'Delete a branch from a repository.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      branch: z.string().describe('Branch name to delete')
    },
    annotations: getToolAnnotations('delete_branch')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${input.branch}` });
      return formatOptimizedResponse({ status: 'Branch deleted', branch: input.branch });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('push_files', {
    description: 'Batch commit and push multiple files in a single atomic commit.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      branch: z.string().describe('Target branch name'),
      message: z.string().describe('Commit message'),
      files: z.array(z.object({
        path: z.string().describe('File path in repository'),
        content: z.string().describe('Content of the file')
      })).describe('Array of files to commit')
    },
    annotations: getToolAnnotations('push_files')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const refRes = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${input.branch}` });
      const parentSha = refRes.data.object.sha;

      const parentCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
      const baseTreeSha = parentCommit.data.tree.sha;

      const treeItems = await Promise.all(input.files.map(async (f: { path: string; content: string }) => {
        const blobRes = await octokit.rest.git.createBlob({
          owner, repo,
          content: Buffer.from(f.content, 'utf-8').toString('base64'),
          encoding: 'base64'
        });
        return {
          path: f.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobRes.data.sha
        };
      }));

      const newTree = await octokit.rest.git.createTree({
        owner, repo,
        base_tree: baseTreeSha,
        tree: treeItems
      });

      const newCommit = await octokit.rest.git.createCommit({
        owner, repo,
        message: input.message,
        tree: newTree.data.sha,
        parents: [parentSha]
      });

      await octokit.rest.git.updateRef({
        owner, repo,
        ref: `heads/${input.branch}`,
        sha: newCommit.data.sha
      });

      return formatOptimizedResponse({
        status: 'Pushed successfully',
        commitSha: newCommit.data.sha,
        filesPushed: input.files.length
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('create_pull_request', {
    description: 'Open a new pull request on GitHub.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      title: z.string().describe('PR title'),
      body: z.string().optional().describe('PR markdown description'),
      head: z.string().describe('The branch containing changes'),
      base: z.string().describe('The branch you want to merge into (e.g. main)'),
      draft: z.boolean().optional().describe('Open as draft PR')
    },
    annotations: getToolAnnotations('create_pull_request')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.pulls.create({
        owner, repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft
      });
      return formatOptimizedResponse({
        prNumber: res.data.number,
        htmlUrl: res.data.html_url,
        state: res.data.state
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('search_code', {
    description: 'Search repository code using GitHub search qualifiers.',
    inputSchema: {
      query: z.string().describe('Search query string'),
      per_page: z.number().optional().describe('Max results (default 30)')
    },
    annotations: getToolAnnotations('search_code')
  }, async (input) => {
    try {
      const res = await octokit.rest.search.code({ q: input.query, per_page: input.per_page || 30 });
      return formatOptimizedResponse({
        totalCount: res.data.total_count,
        items: res.data.items.map(i => ({ name: i.name, path: i.path, repo: i.repository.full_name, url: i.html_url }))
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('search_repositories', {
    description: 'Search GitHub repositories by keyword, language, or stars.',
    inputSchema: {
      query: z.string().describe('Search query (e.g. "mcp server language:typescript")'),
      per_page: z.number().optional().describe('Results per page')
    },
    annotations: getToolAnnotations('search_repositories')
  }, async (input) => {
    try {
      const res = await octokit.rest.search.repos({ q: input.query, per_page: input.per_page || 20 });
      return formatOptimizedResponse({
        totalCount: res.data.total_count,
        repos: res.data.items.map(r => ({
          fullName: r.full_name,
          description: r.description,
          stars: r.stargazers_count,
          url: r.html_url
        }))
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('list_issues', {
    description: 'List issues in a repository with state and label filters.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by issue state'),
      labels: z.string().optional().describe('Comma-separated label list')
    },
    annotations: getToolAnnotations('list_issues')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.issues.listForRepo({ owner, repo, state: input.state || 'open', labels: input.labels });
      return formatOptimizedResponse(res.data.map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login,
        labels: i.labels.map((l: any) => typeof l === 'string' ? l : l.name),
        comments: i.comments
      })));
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('list_pull_requests', {
    description: 'List pull requests in a repository.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('PR state')
    },
    annotations: getToolAnnotations('list_pull_requests')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.pulls.list({ owner, repo, state: input.state || 'open' });
      return formatOptimizedResponse(res.data.map(p => ({
        number: p.number,
        title: p.title,
        state: p.state,
        author: p.user?.login,
        head: p.head.ref,
        base: p.base.ref,
        draft: p.draft
      })));
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('issue_read', {
    description: 'Read complete issue details and discussion comments.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      issue_number: z.number().describe('Issue number')
    },
    annotations: getToolAnnotations('issue_read')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const [issue, comments] = await Promise.all([
        octokit.rest.issues.get({ owner, repo, issue_number: input.issue_number }),
        octokit.rest.issues.listComments({ owner, repo, issue_number: input.issue_number })
      ]);
      return formatOptimizedResponse({
        number: issue.data.number,
        title: issue.data.title,
        state: issue.data.state,
        body: issue.data.body,
        author: issue.data.user?.login,
        comments: comments.data.map(c => ({ author: c.user?.login, body: c.body, created_at: c.created_at }))
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('issue_write', {
    description: 'Create a new issue or update title, body, state, labels, or assignees of an existing issue.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      issue_number: z.number().optional().describe('Issue number to edit (omit to create new issue)'),
      title: z.string().optional().describe('Issue title'),
      body: z.string().optional().describe('Issue description markdown'),
      state: z.enum(['open', 'closed']).optional().describe('Issue state'),
      labels: z.array(z.string()).optional().describe('Labels to apply'),
      assignees: z.array(z.string()).optional().describe('GitHub usernames to assign')
    },
    annotations: getToolAnnotations('issue_write')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      if (input.issue_number) {
        const res = await octokit.rest.issues.update({
          owner, repo,
          issue_number: input.issue_number,
          title: input.title,
          body: input.body,
          state: input.state,
          labels: input.labels,
          assignees: input.assignees
        });
        return formatOptimizedResponse({ status: 'Issue updated', number: res.data.number });
      } else {
        if (!input.title) throw new Error("Title is required when creating a new issue.");
        const res = await octokit.rest.issues.create({
          owner, repo,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees
        });
        return formatOptimizedResponse({ status: 'Issue created', number: res.data.number, url: res.data.html_url });
      }
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('add_issue_comment', {
    description: 'Add a markdown comment to an issue or pull request.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      issue_number: z.number().describe('Issue or PR number'),
      body: z.string().describe('Comment markdown text')
    },
    annotations: getToolAnnotations('add_issue_comment')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.issues.createComment({
        owner, repo,
        issue_number: input.issue_number,
        body: input.body
      });
      return formatOptimizedResponse({ status: 'Comment added', commentId: res.data.id, url: res.data.html_url });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('pull_request_read', {
    description: 'Read comprehensive pull request details, mergeability status, review comments, and changed files.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      pr_number: z.number().describe('Pull request number')
    },
    annotations: getToolAnnotations('pull_request_read')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const [pr, files] = await Promise.all([
        octokit.rest.pulls.get({ owner, repo, pull_number: input.pr_number }),
        octokit.rest.pulls.listFiles({ owner, repo, pull_number: input.pr_number })
      ]);
      return formatOptimizedResponse({
        number: pr.data.number,
        title: pr.data.title,
        state: pr.data.state,
        mergeable: pr.data.mergeable,
        changedFilesCount: pr.data.changed_files,
        additions: pr.data.additions,
        deletions: pr.data.deletions,
        files: files.data.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }))
      });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });

  register('merge_pull_request', {
    description: 'Merge a pull request using merge, squash, or rebase strategy.',
    inputSchema: {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      pr_number: z.number().describe('Pull request number to merge'),
      commit_title: z.string().optional().describe('Title for merge commit'),
      merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: squash)')
    },
    annotations: getToolAnnotations('merge_pull_request')
  }, async (input) => {
    try {
      const { owner, repo } = resolveRepo(input.owner, input.repo, sessionId);
      const res = await octokit.rest.pulls.merge({
        owner, repo,
        pull_number: input.pr_number,
        commit_title: input.commit_title,
        merge_method: input.merge_method || 'squash'
      });
      return formatOptimizedResponse({ merged: res.data.merged, sha: res.data.sha, message: res.data.message });
    } catch (err: any) {
      return handleGitHubError(err);
    }
  });
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

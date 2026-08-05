import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations, resolveInputString, getSessionContext, updateSessionContext, safeRegexTest } from './security.js';

function handleGitHubError(err: any): any {
  if (err?.status === 403 && err?.headers?.['x-ratelimit-remaining'] === '0') {
    const resetTime = err.headers['x-ratelimit-reset']
      ? new Date(parseInt(err.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString()
      : 'soon';
    return formatError(new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`));
  }
  return formatError(err);
}

function resolveRepo(inputOwner?: string, inputRepo?: string, sessionId: string = 'default'): { owner: string; repo: string } {
  const ctx = getSessionContext(sessionId);
  const owner = inputOwner || ctx.owner;
  const repo = inputRepo || ctx.repo;
  if (!owner || !repo) {
    throw new Error('Target repository context missing. Pass owner/repo or call set_active_context tool once.');
  }
  return { owner, repo };
}

export function registerGitHubTools(server: McpServer, octokit: Octokit) {
  // Context Persistence Tool
  server.registerTool('set_active_context', {
    description: 'Set default GitHub repository context once per session so owner/repo parameters are optional in subsequent calls.',
    inputSchema: { owner: z.string(), repo: z.string(), branch: z.string().optional().default('main') },
    annotations: getToolAnnotations('set_active_context')
  }, async ({ owner, repo, branch }) => {
    updateSessionContext('default', { owner, repo, branch });
    return formatOptimizedResponse(`Active repository context set to '${owner}/${repo}' on branch '${branch}'.`);
  });

  // 1. get_me
  server.registerTool('get_me', {
    description: 'Get authenticated user profile details.',
    inputSchema: {},
    annotations: getToolAnnotations('get_me')
  }, async () => {
    try {
      const res = await octokit.users.getAuthenticated();
      return formatOptimizedResponse({ login: res.data.login, name: res.data.name });
    } catch (err) { return handleGitHubError(err); }
  });

  // 2. get_file_contents
  server.registerTool('get_file_contents', {
    description: 'Fetch file contents or line window. (Owner/repo optional if context set)',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      path: z.string(),
      ref: z.string().optional(),
      startLine: z.number().optional().default(1),
      limit: z.number().optional().default(100)
    },
    annotations: getToolAnnotations('get_file_contents')
  }, async ({ owner, repo, path, ref, startLine, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const activeRef = ref || getSessionContext('default').branch || 'main';
      const res = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeRef });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        const start = Math.max(1, startLine);
        const end = Math.min(lines.length, start + limit - 1);
        const slice = lines.slice(start - 1, end).map((l, i) => `${(start + i).toString().padStart(5, ' ')} | ${l}`).join('\n');
        return formatOptimizedResponse(`[L${start}-L${end} / ${lines.length}]\n\n${slice}`);
      }
      return formatOptimizedResponse('Not a standard text file.');
    } catch (err) { return handleGitHubError(err); }
  });

  // 3. YOUR EXISTING SURGICAL STR REPLACE EDITOR (PRESERVED & OPTIMIZED)
  server.registerTool('str_replace_editor', {
    description: 'Surgically search and replace code block. Supports Base64 (old_str_b64, new_str_b64). Owner/repo optional if context set.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      path: z.string(),
      branch: z.string().optional(),
      old_str: z.string().optional(),
      old_str_b64: z.string().optional(),
      new_str: z.string().optional(),
      new_str_b64: z.string().optional(),
      message: z.string()
    },
    annotations: getToolAnnotations('str_replace_editor')
  }, async ({ owner, repo, path, branch, old_str, old_str_b64, new_str, new_str_b64, message }) => {
    try {
      const target = resolveRepo(owner, repo);
      const activeBranch = branch || getSessionContext('default').branch || 'main';
      const resolvedOld = resolveInputString(old_str, old_str_b64);
      const resolvedNew = resolveInputString(new_str, new_str_b64);

      if (!resolvedOld) throw new Error('Either old_str or old_str_b64 must be provided.');

      const fileData = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeBranch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) throw new Error('Target is not a file.');
      const raw = Buffer.from(fileData.data.content, 'base64').toString('utf-8');
      
      const normalizedContent = raw.replace(/\r\n/g, '\n');
      const normalizedOld = resolvedOld.replace(/\r\n/g, '\n');
      const normalizedNew = resolvedNew.replace(/\r\n/g, '\n');

      if (!normalizedContent.includes(normalizedOld)) {
        throw new Error('Target old_str sequence block not found in file. Check formatting and indentation.');
      }

      const updated = normalizedContent.replace(normalizedOld, normalizedNew);
      const res = await octokit.repos.createOrUpdateFileContents({
        owner: target.owner, repo: target.repo, path, message, content: Buffer.from(updated, 'utf-8').toString('base64'), branch: activeBranch, sha: fileData.data.sha
      });
      return formatOptimizedResponse(`Surgical replacement committed: ${res.data.commit.sha}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 4. YOUR EXISTING GREP TOOL (PRESERVED & OPTIMIZED)
  server.registerTool('grep', {
    description: 'High-performance pattern search with line windowing and context.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      pattern: z.string(),
      path: z.string().optional(),
      ref: z.string().optional(),
      limit: z.number().optional().default(10)
    },
    annotations: getToolAnnotations('grep')
  }, async ({ owner, repo, pattern, path, ref, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const activeRef = ref || getSessionContext('default').branch || 'main';

      if (path) {
        const res = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeRef });
        if ('content' in res.data && typeof res.data.content === 'string') {
          const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
          const lines = raw.split('\n');
          const matches: string[] = [];
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(pattern.toLowerCase())) {
              matches.push(`L${idx + 1}: ${line}`);
            }
          });
          return formatOptimizedResponse(matches.slice(0, limit).join('\n') || 'No matches found in target path.');
        }
      }

      const searchRes = await octokit.search.code({ q: `${pattern} repo:${target.owner}/${target.repo}`, per_page: limit });
      return formatOptimizedResponse(searchRes.data.items.map(i => `- ${i.path}`).join('\n') || 'No code matches.');
    } catch (err) { return handleGitHubError(err); }
  });

  // 5. YOUR EXISTING FILE OUTLINE EXTRACTOR (PRESERVED & OPTIMIZED)
  server.registerTool('view_file_outline', {
    description: 'Extract high-level AST symbol structure (classes, functions, methods, imports).',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), path: z.string(), ref: z.string().optional() },
    annotations: getToolAnnotations('view_file_outline')
  }, async ({ owner, repo, path, ref }) => {
    try {
      const target = resolveRepo(owner, repo);
      const activeRef = ref || getSessionContext('default').branch || 'main';
      const res = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeRef });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        const outline: string[] = [];
        lines.forEach((line, idx) => {
          const trimmed = line.trim();
          if (/^(export\s+)?(function|class|interface|type|const|let|var|def)\s+\w+/.test(trimmed) || trimmed.startsWith('import ')) {
            outline.push(`L${idx + 1}: ${trimmed.slice(0, 100)}`);
          }
        });
        return formatOptimizedResponse(outline.length ? outline.join('\n') : 'No major declarations found.');
      }
      return formatOptimizedResponse('Not a text file.');
    } catch (err) { return handleGitHubError(err); }
  });

  // 6. get_commit
  server.registerTool('get_commit', {
    description: 'Get commit details by SHA.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), commit_sha: z.string() },
    annotations: getToolAnnotations('get_commit')
  }, async ({ owner, repo, commit_sha }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.getCommit({ owner: target.owner, repo: target.repo, ref: commit_sha });
      return formatOptimizedResponse({ sha: res.data.sha, message: res.data.commit.message, author: res.data.commit.author?.name });
    } catch (err) { return handleGitHubError(err); }
  });

  // 7. get_label
  server.registerTool('get_label', {
    description: 'Get details of an issue label.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), name: z.string() },
    annotations: getToolAnnotations('get_label')
  }, async ({ owner, repo, name }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.issues.getLabel({ owner: target.owner, repo: target.repo, name });
      return formatOptimizedResponse(res.data);
    } catch (err) { return handleGitHubError(err); }
  });

  // 8. get_latest_release
  server.registerTool('get_latest_release', {
    description: 'Get latest published release.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('get_latest_release')
  }, async ({ owner, repo }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.getLatestRelease({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse({ tag: res.data.tag_name, name: res.data.name });
    } catch (err) { return handleGitHubError(err); }
  });

  // 9. get_release_by_tag
  server.registerTool('get_release_by_tag', {
    description: 'Get release by tag name.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), tag: z.string() },
    annotations: getToolAnnotations('get_release_by_tag')
  }, async ({ owner, repo, tag }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.getReleaseByTag({ owner: target.owner, repo: target.repo, tag });
      return formatOptimizedResponse(res.data);
    } catch (err) { return handleGitHubError(err); }
  });

  // 10. get_tag
  server.registerTool('get_tag', {
    description: 'Get tag object details.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), tag_sha: z.string() },
    annotations: getToolAnnotations('get_tag')
  }, async ({ owner, repo, tag_sha }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.git.getTag({ owner: target.owner, repo: target.repo, tag_sha });
      return formatOptimizedResponse(res.data);
    } catch (err) { return handleGitHubError(err); }
  });

  // 11. get_team_members
  server.registerTool('get_team_members', {
    description: 'List members of an organization team.',
    inputSchema: { org: z.string(), team_slug: z.string() },
    annotations: getToolAnnotations('get_team_members')
  }, async ({ org, team_slug }) => {
    try {
      const res = await octokit.teams.listMembersInOrg({ org, team_slug });
      return formatOptimizedResponse(res.data.map(m => m.login));
    } catch (err) { return handleGitHubError(err); }
  });

  // 12. get_teams
  server.registerTool('get_teams', {
    description: 'List teams in an organization.',
    inputSchema: { org: z.string() },
    annotations: getToolAnnotations('get_teams')
  }, async ({ org }) => {
    try {
      const res = await octokit.teams.list({ org });
      return formatOptimizedResponse(res.data.map(t => ({ id: t.id, name: t.name, slug: t.slug })));
    } catch (err) { return handleGitHubError(err); }
  });

  // 13. list_branches
  server.registerTool('list_branches', {
    description: 'List repository branches.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_branches')
  }, async ({ owner, repo, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.listBranches({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(b => `${b.name} (${b.commit.sha.substring(0, 7)})`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 14. list_commits
  server.registerTool('list_commits', {
    description: 'List recent commits.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('list_commits')
  }, async ({ owner, repo, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.listCommits({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(c => `- ${c.sha.substring(0, 7)}: ${c.commit.message.split('\n')[0]}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 15. list_issue_fields
  server.registerTool('list_issue_fields', {
    description: 'List custom issue fields.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_issue_fields')
  }, async ({ owner, repo }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.issues.listLabelsForRepo({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(res.data.map(l => l.name));
    } catch (err) { return handleGitHubError(err); }
  });

  // 16. list_issue_types
  server.registerTool('list_issue_types', {
    description: 'List issue types.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_issue_types')
  }, async () => formatOptimizedResponse(["Bug", "Feature", "Task", "Improvement"]));

  // 17. list_issues
  server.registerTool('list_issues', {
    description: 'List issues in repo.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_issues')
  }, async ({ owner, repo, state, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.issues.listForRepo({ owner: target.owner, repo: target.repo, state, per_page: limit });
      return formatOptimizedResponse(res.data.map(i => `#${i.number} [${i.state}]: ${i.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 18. list_pull_requests
  server.registerTool('list_pull_requests', {
    description: 'List pull requests.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_pull_requests')
  }, async ({ owner, repo, state, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.list({ owner: target.owner, repo: target.repo, state, per_page: limit });
      return formatOptimizedResponse(res.data.map(p => `#${p.number} [${p.state}]: ${p.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 19. list_releases
  server.registerTool('list_releases', {
    description: 'List releases.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('list_releases')
  }, async ({ owner, repo, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.listReleases({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(r => `${r.tag_name}: ${r.name || 'Untitled'}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 20. list_repository_collaborators
  server.registerTool('list_repository_collaborators', {
    description: 'List collaborators.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_repository_collaborators')
  }, async ({ owner, repo }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.listCollaborators({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(res.data.map(c => `${c.login} (${c.permissions?.admin ? 'admin' : 'write'})`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 21. list_tags
  server.registerTool('list_tags', {
    description: 'List git tags.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_tags')
  }, async ({ owner, repo, limit }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.listTags({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(t => `${t.name} -> ${t.commit.sha.substring(0, 7)}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 22. issue_read
  server.registerTool('issue_read', {
    description: 'Read detailed issue information.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), issue_number: z.number() },
    annotations: getToolAnnotations('issue_read')
  }, async ({ owner, repo, issue_number }) => {
    try {
      const target = resolveRepo(owner, repo);
      const issue = await octokit.issues.get({ owner: target.owner, repo: target.repo, issue_number });
      return formatOptimizedResponse({ number: issue.data.number, title: issue.data.title, body: issue.data.body, state: issue.data.state });
    } catch (err) { return handleGitHubError(err); }
  });

  // 23. pull_request_read
  server.registerTool('pull_request_read', {
    description: 'Read detailed pull request.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('pull_request_read')
  }, async ({ owner, repo, pull_number }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number });
      return formatOptimizedResponse({ number: res.data.number, title: res.data.title, state: res.data.state, mergeable: res.data.mergeable });
    } catch (err) { return handleGitHubError(err); }
  });

  // 24. search_code
  server.registerTool('search_code', {
    description: 'Search code across repositories.',
    inputSchema: { q: z.string(), owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_code')
  }, async ({ q, owner, repo, limit }) => {
    try {
      let query = q;
      if (owner && repo) query += ` repo:${owner}/${repo}`;
      else {
        const ctx = getSessionContext('default');
        if (ctx.owner && ctx.repo) query += ` repo:${ctx.owner}/${ctx.repo}`;
      }
      const res = await octokit.search.code({ q: query, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(i => `${i.repository.full_name}:${i.path}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 25. search_commits
  server.registerTool('search_commits', {
    description: 'Search commits.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_commits')
  }, async ({ q, limit }) => {
    try {
      const res = await octokit.search.commits({ q, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(c => `${c.sha.substring(0, 7)}: ${c.commit.message.split('\n')[0]}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 26. search_issues
  server.registerTool('search_issues', {
    description: 'Search issues.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_issues')
  }, async ({ q, limit }) => {
    try {
      const res = await octokit.search.issuesAndPullRequests({ q: `${q} is:issue`, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(i => `#${i.number}: ${i.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 27. search_pull_requests
  server.registerTool('search_pull_requests', {
    description: 'Search pull requests.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_pull_requests')
  }, async ({ q, limit }) => {
    try {
      const res = await octokit.search.issuesAndPullRequests({ q: `${q} is:pr`, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(p => `PR #${p.number}: ${p.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 28. search_repositories
  server.registerTool('search_repositories', {
    description: 'Search repositories.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_repositories')
  }, async ({ q, limit }) => {
    try {
      const res = await octokit.search.repos({ q, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(r => `${r.full_name} [${r.default_branch}]`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 29. search_users
  server.registerTool('search_users', {
    description: 'Search users.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_users')
  }, async ({ q, limit }) => {
    try {
      const res = await octokit.search.users({ q, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(u => u.login).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  // 30. run_secret_scanning
  server.registerTool('run_secret_scanning', {
    description: 'Run secret scanning check.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('run_secret_scanning')
  }, async ({ owner, repo }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.secretScanning.listAlertsForRepo({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(`Secret Scanning: Found ${res.data.length} active alerts.`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 31. add_comment_to_pending_review
  server.registerTool('add_comment_to_pending_review', {
    description: 'Add line comment to pending review.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), body: z.string(), path: z.string(), line: z.number() },
    annotations: getToolAnnotations('add_comment_to_pending_review')
  }, async ({ owner, repo, pull_number, body, path, line }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.createReviewComment({ owner: target.owner, repo: target.repo, pull_number, body, path, line });
      return formatOptimizedResponse(`Comment ID: ${res.data.id}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 32. add_issue_comment
  server.registerTool('add_issue_comment', {
    description: 'Add comment to issue or PR.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), issue_number: z.number(), body: z.string() },
    annotations: getToolAnnotations('add_issue_comment')
  }, async ({ owner, repo, issue_number, body }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.issues.createComment({ owner: target.owner, repo: target.repo, issue_number, body });
      return formatOptimizedResponse(`Comment added #${issue_number}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 33. add_reply_to_pull_request_comment
  server.registerTool('add_reply_to_pull_request_comment', {
    description: 'Reply to PR comment.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), comment_id: z.number(), body: z.string() },
    annotations: getToolAnnotations('add_reply_to_pull_request_comment')
  }, async ({ owner, repo, pull_number, comment_id, body }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.createReplyForReviewComment({ owner: target.owner, repo: target.repo, pull_number, comment_id, body });
      return formatOptimizedResponse(`Reply submitted ID: ${res.data.id}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 34. create_branch
  server.registerTool('create_branch', {
    description: 'Create branch.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string(), refSha: z.string() },
    annotations: getToolAnnotations('create_branch')
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      const target = resolveRepo(owner, repo);
      await octokit.git.createRef({ owner: target.owner, repo: target.repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatOptimizedResponse(`Branch '${branch}' created.`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 35. create_or_update_file
  server.registerTool('create_or_update_file', {
    description: 'Create or update file. Supports Base64 (content_b64).',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      path: z.string(),
      content: z.string().optional(),
      content_b64: z.string().optional(),
      message: z.string(),
      branch: z.string().optional(),
      sha: z.string().optional()
    },
    annotations: getToolAnnotations('create_or_update_file')
  }, async ({ owner, repo, path, content, content_b64, message, branch, sha }) => {
    try {
      const target = resolveRepo(owner, repo);
      const activeBranch = branch || getSessionContext('default').branch || 'main';
      const text = resolveInputString(content, content_b64);
      const res = await octokit.repos.createOrUpdateFileContents({
        owner: target.owner, repo: target.repo, path, message, content: Buffer.from(text, 'utf-8').toString('base64'), branch: activeBranch, sha
      });
      return formatOptimizedResponse(`Committed SHA: ${res.data.commit.sha}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 36. create_pull_request
  server.registerTool('create_pull_request', {
    description: 'Create pull request.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main') },
    annotations: getToolAnnotations('create_pull_request')
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.create({ owner: target.owner, repo: target.repo, title, body, head, base });
      return formatOptimizedResponse(`PR #${res.data.number} created.`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 37. create_repository
  server.registerTool('create_repository', {
    description: 'Create new repo.',
    inputSchema: { name: z.string(), private: z.boolean().default(true), description: z.string().optional() },
    annotations: getToolAnnotations('create_repository')
  }, async ({ name, private: isPrivate, description }) => {
    try {
      const res = await octokit.repos.createForAuthenticatedUser({ name, private: isPrivate, description });
      updateSessionContext('default', { owner: res.data.owner.login, repo: res.data.name });
      return formatOptimizedResponse(`Repo created: ${res.data.full_name}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 38. delete_file
  server.registerTool('delete_file', {
    description: 'Delete file.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string() },
    annotations: getToolAnnotations('delete_file')
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      const target = resolveRepo(owner, repo);
      await octokit.repos.deleteFile({ owner: target.owner, repo: target.repo, path, message, sha, branch });
      return formatOptimizedResponse(`Deleted ${path}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 39. fork_repository
  server.registerTool('fork_repository', {
    description: 'Fork repo.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('fork_repository')
  }, async ({ owner, repo }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.repos.createFork({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(`Forked to ${res.data.full_name}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 40. issue_write
  server.registerTool('issue_write', {
    description: 'Create or update issue.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), title: z.string(), body: z.string().optional(), issue_number: z.number().optional() },
    annotations: getToolAnnotations('issue_write')
  }, async ({ owner, repo, title, body, issue_number }) => {
    try {
      const target = resolveRepo(owner, repo);
      if (issue_number) {
        const res = await octokit.issues.update({ owner: target.owner, repo: target.repo, issue_number, title, body });
        return formatOptimizedResponse(`Issue #${res.data.number} updated.`);
      } else {
        const res = await octokit.issues.create({ owner: target.owner, repo: target.repo, title, body });
        return formatOptimizedResponse(`Issue #${res.data.number} created.`);
      }
    } catch (err) { return handleGitHubError(err); }
  });

  // 41. merge_pull_request
  server.registerTool('merge_pull_request', {
    description: 'Merge PR.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('merge_pull_request')
  }, async ({ owner, repo, pull_number }) => {
    try {
      const target = resolveRepo(owner, repo);
      const res = await octokit.pulls.merge({ owner: target.owner, repo: target.repo, pull_number });
      return formatOptimizedResponse(`Merged PR #${pull_number}`);
    } catch (err) { return handleGitHubError(err); }
  });

  // 42. pull_request_review_write
  server.registerTool('pull_request_review_write', {
    description: 'Submit PR review.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), body: z.string().optional() },
    annotations: getToolAnnotations('pull_request_review_write')
  }, async ({ owner, repo, pul
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations, resolveInputString, getSessionContext, updateSessionContext, makeRegistrar } from './security.js';

function handleGitHubError(err: any): any {
  if (err?.status === 403 && err?.headers?.['x-ratelimit-remaining'] === '0') {
    const resetTime = err.headers['x-ratelimit-reset']
      ? new Date(parseInt(err.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString()
      : 'soon';
    return formatError(new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`));
  }
  return formatError(err);
}

function resolveRepo(inputOwner: string | undefined, inputRepo: string | undefined, sessionId: string): { owner: string; repo: string } {
  const ctx = getSessionContext(sessionId);
  const owner = inputOwner || ctx.owner;
  const repo = inputRepo || ctx.repo;
  if (!owner || !repo) {
    throw new Error('Target repository context missing. Pass owner/repo or call set_active_context tool once.');
  }
  return { owner, repo };
}

function editDistance(s1: string, s2: string): number {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

function getSimilarity(s1: string, s2: string): number {
  let longer = s1;
  let shorter = s2;
  if (s1.length < s2.length) {
    longer = s2;
    shorter = s1;
  }
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

function getBestMatchFeedback(content: string, oldStr: string): string {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');
  const n = contentLines.length;
  const m = oldLines.length;
  let bestRatio = 0;
  let bestStartIdx = -1;
  let bestEndIdx = -1;
  if (!oldStr.trim()) return "Error: Target old_str is blank.";

  for (let i = 0; i <= n - m; i++) {
    const window = contentLines.slice(i, i + m).join('\n');
    const sim = getSimilarity(window, oldStr);
    if (sim > bestRatio) {
      bestRatio = sim;
      bestStartIdx = i;
      bestEndIdx = i + m;
    }
  }

  if (bestRatio > 0.4) {
    const closestSnippet: string[] = [];
    const contextStart = Math.max(0, bestStartIdx - 3);
    const contextEnd = Math.min(n, bestEndIdx + 3);
    for (let idx = contextStart; idx < contextEnd; idx++) {
      const isTarget = idx >= bestStartIdx && idx < bestEndIdx;
      const prefix = isTarget ? ">> " : "   ";
      closestSnippet.push(`${prefix}L${idx + 1}: ${contentLines[idx]}`);
    }
    return `Error: Target old_str sequence block not found in file.\n\n` +
           `Closest match found (similarity ${(bestRatio * 100).toFixed(1)}%):\n` +
           `-----------------------------------------\n` +
           `${closestSnippet.join('\n')}\n` +
           `-----------------------------------------\n\n` +
           `Check formatting, indentation, and brackets inside old_str precisely.`;
  }
  return "Error: Target old_str sequence block not found in file. Check target file parameters and try again.";
}

export function registerGitHubTools(server: McpServer, octokit: Octokit, sessionId: string, registry: Record<string, any>) {
  const reg = makeRegistrar(server, registry);

  reg('set_active_context', {
    description: 'Set default GitHub repo/branch context and/or default sandbox cwd + env vars, once per authenticated identity.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      cwd: z.string().optional().describe('Default working directory for sandbox_exec/sandbox_run/sandbox_install/sandbox_file when no explicit dir is given.'),
      env: z.record(z.string()).optional().describe('Default environment variables merged into every sandbox command.')
    },
    annotations: getToolAnnotations('set_active_context')
  }, async (args: any) => {
    const { owner, repo, branch, cwd, env } = args;
    const patch: Record<string, any> = {};
    if (owner !== undefined) patch.owner = owner;
    if (repo !== undefined) patch.repo = repo;
    if (branch !== undefined) patch.branch = branch;
    if (cwd !== undefined) patch.cwd = cwd;
    if (env !== undefined) patch.env = env;
    if (Object.keys(patch).length === 0) return formatError('Provide at least one of owner/repo/branch/cwd/env.');
    updateSessionContext(sessionId, patch);
    const parts: string[] = [];
    if (owner && repo) parts.push(`repo '${owner}/${repo}'${branch ? ` on branch '${branch}'` : ''}`);
    if (cwd) parts.push(`cwd '${cwd}'`);
    if (env) parts.push(`${Object.keys(env).length} env var(s)`);
    return formatOptimizedResponse(`Active context updated: ${parts.join(', ')}.`);
  });

  reg('get_me', {
    description: 'Get authenticated user profile details.',
    inputSchema: {},
    annotations: getToolAnnotations('get_me')
  }, async () => {
    try {
      const res = await octokit.users.getAuthenticated();
      return formatOptimizedResponse({ login: res.data.login, name: res.data.name });
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_file_contents', {
    description: 'Fetch file contents or specific line window. Default limit 100 lines, max limit 500 lines.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      path: z.string(),
      ref: z.string().optional(),
      startLine: z.number().optional().default(1),
      endLine: z.number().optional(),
      limit: z.number().optional().default(100)
    },
    annotations: getToolAnnotations('get_file_contents')
  }, async (args: any) => {
    const { owner, repo, path, ref, startLine, endLine, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeRef = ref || getSessionContext(sessionId).branch || 'main';
      const res = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeRef });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        const start = Math.max(1, startLine || 1);
        let lineCount = limit || 100;
        if (endLine !== undefined && endLine !== null && endLine >= start) {
          lineCount = endLine - start + 1;
        }
        lineCount = Math.min(500, Math.max(1, lineCount));
        const end = Math.min(lines.length, start + lineCount - 1);
        const slice = lines.slice(start - 1, end).map((l, i) => `${(start + i).toString().padStart(5, ' ')} | ${l}`).join('\n');
        return formatOptimizedResponse(`[L${start}-L${end} / ${lines.length}]\n\n${slice}`, 100000);
      }
      return formatOptimizedResponse('Not a standard text file.');
    } catch (err) { return handleGitHubError(err); }
  });

  reg('str_replace_editor', {
    description: 'Surgically search and replace code block. Supports Base64 parameters.',
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
  }, async (args: any) => {
    const { owner, repo, path, branch, old_str, old_str_b64, new_str, new_str_b64, message } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeBranch = branch || getSessionContext(sessionId).branch || 'main';
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
        const feedback = getBestMatchFeedback(normalizedContent, normalizedOld);
        throw new Error(feedback);
      }

      const updated = normalizedContent.replace(normalizedOld, normalizedNew);
      const res = await octokit.repos.createOrUpdateFileContents({
        owner: target.owner, repo: target.repo, path, message, content: Buffer.from(updated, 'utf-8').toString('base64'), branch: activeBranch, sha: fileData.data.sha
      });
      return formatOptimizedResponse(`Surgical replacement committed: ${res.data.commit.sha}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('grep', {
    description: 'High-performance pattern search with line windowing and optional filters.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      pattern: z.string(),
      path: z.string().optional(),
      ref: z.string().optional(),
      glob: z.string().optional().describe('Filter matching paths by substring/glob pattern'),
      type: z.string().optional().describe('Filter by file extension (e.g. ts, py)'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().default('content'),
      case_insensitive: z.boolean().optional().default(true),
      show_line_numbers: z.boolean().optional().default(true),
      context_before: z.number().optional().default(0),
      context_after: z.number().optional().default(0),
      offset: z.number().optional().default(0),
      limit: z.number().optional().default(10)
    },
    annotations: getToolAnnotations('grep')
  }, async (args: any) => {
    const { owner, repo, pattern, path, ref, glob, type, output_mode, case_insensitive, show_line_numbers, context_before, context_after, offset, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeRef = ref || getSessionContext(sessionId).branch || 'main';
      const mode = output_mode || 'content';
      const isCaseInsensitive = case_insensitive !== false;
      const before = Math.min(Math.max(0, context_before || 0), 10);
      const after = Math.min(Math.max(0, context_after || 0), 10);
      const showLineNums = show_line_numbers !== false;
      const maxLimit = Math.min(limit || 10, 50);
      const startOffset = Math.max(0, offset || 0);

      if (path) {
        const res = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeRef });
        if ('content' in res.data && typeof res.data.content === 'string') {
          const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
          const lines = raw.split('\n');
          const matchedIndices: number[] = [];
          lines.forEach((line, idx) => {
            const matched = isCaseInsensitive
              ? line.toLowerCase().includes(pattern.toLowerCase())
              : line.includes(pattern);
            if (matched) matchedIndices.push(idx);
          });

          if (matchedIndices.length === 0) {
            return formatOptimizedResponse('No matches found in target path.');
          }

          if (mode === 'files_with_matches') return formatOptimizedResponse(`Matching target path:\n- ${path}`);
          if (mode === 'count') return formatOptimizedResponse(`File: ${path} - ${matchedIndices.length} matches`);

          const sliced = matchedIndices.slice(startOffset, startOffset + maxLimit);
          const processed = new Set<number>();
          const outputLines: string[] = [];

          sliced.forEach(matchIdx => {
            const s = Math.max(0, matchIdx - before);
            const e = Math.min(lines.length - 1, matchIdx + after);
            for (let i = s; i <= e; i++) {
              if (processed.has(i)) continue;
              processed.add(i);
              const prefix = i === matchIdx ? '>> ' : '   ';
              const numStr = showLineNums ? `L${i + 1} | ` : '';
              outputLines.push(`${prefix}${numStr}${lines[i]}`);
            }
          });
          return formatOptimizedResponse(`File: ${path} (${matchedIndices.length} total matches)\n\n${outputLines.join('\n')}`);
        }
      }

      let query = pattern;
      query += ` repo:${target.owner}/${target.repo}`;
      if (type) query += ` extension:${type}`;

      const searchRes = await octokit.search.code({ q: query, per_page: maxLimit });
      let items = searchRes.data.items || [];
      if (glob) {
        const lowerGlob = glob.toLowerCase().replace(/\*/g, '');
        items = items.filter(i => i.path.toLowerCase().includes(lowerGlob));
      }

      if (items.length === 0) return formatOptimizedResponse('No code matches found.');
      if (mode === 'files_with_matches') {
        return formatOptimizedResponse(items.map(i => `- ${i.path}`).join('\n'));
      }

      return formatOptimizedResponse(items.map(i => `- ${i.path}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('view_file_outline', {
    description: 'Extract high-level AST symbol structure.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), path: z.string(), ref: z.string().optional() },
    annotations: getToolAnnotations('view_file_outline')
  }, async (args: any) => {
    const { owner, repo, path, ref } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeRef = ref || getSessionContext(sessionId).branch || 'main';
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

  reg('git_tree', {
    description: 'Retrieve file path tree index recursively.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      tree_sha: z.string().optional(),
      offset: z.number().optional().default(0),
      limit: z.number().optional().default(50),
      q: z.string().optional()
    },
    annotations: getToolAnnotations('git_tree')
  }, async (args: any) => {
    const { owner, repo, tree_sha, offset, limit, q } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeSha = tree_sha || getSessionContext(sessionId).branch || 'main';
      const res = await octokit.git.getTree({ owner: target.owner, repo: target.repo, tree_sha: activeSha, recursive: 'true' });
      let tree = res.data.tree;
      if (q) {
        const lowerQ = q.toLowerCase();
        tree = tree.filter(t => (t.path || '').toLowerCase().includes(lowerQ));
      }
      const total = tree.length;
      const targetLimit = Math.min(limit || 50, 200);
      const startIdx = Math.max(0, offset || 0);
      const items = tree.slice(startIdx, startIdx + targetLimit).map(t =>
        `${t.type === 'tree' ? '[D]' : '[F]'} ${t.path}`
      );
      const out = items.join('\n');
      const meta = `Showing items ${startIdx + 1}-${Math.min(startIdx + targetLimit, total)} of ${total} paths.`;
      return formatOptimizedResponse(`${meta}\n\n${out || 'No paths located.'}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('patch_contents', {
    description: 'Replace specified line range directly by line numbers. Supports newContent_b64 for Base64 inputs.',
    inputSchema: {
      owner: z.string().optional(),
      repo: z.string().optional(),
      path: z.string(),
      branch: z.string().optional(),
      startLine: z.number().describe('1-indexed start line number'),
      endLine: z.number().describe('1-indexed end line number'),
      newContent: z.string().optional(),
      newContent_b64: z.string().optional(),
      message: z.string()
    },
    annotations: getToolAnnotations('patch_contents')
  }, async (args: any) => {
    const { owner, repo, path, branch, startLine, endLine, newContent, newContent_b64, message } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeBranch = branch || getSessionContext(sessionId).branch || 'main';
      const resolvedNew = resolveInputString(newContent, newContent_b64);
      const fileData = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeBranch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) throw new Error('Target is not a file.');

      const raw = Buffer.from(fileData.data.content, 'base64').toString('utf-8');
      const lines = raw.split('\n');
      if (startLine < 1 || endLine < startLine || endLine > lines.length) {
        throw new Error(`Invalid line coordinates. Target file has ${lines.length} lines.`);
      }

      lines.splice(startLine - 1, endLine - startLine + 1, ...resolvedNew.split('\n'));
      const updated = lines.join('\n');
      const res = await octokit.repos.createOrUpdateFileContents({
        owner: target.owner, repo: target.repo, path, message, content: Buffer.from(updated, 'utf-8').toString('base64'), branch: activeBranch, sha: fileData.data.sha
      });
      return formatOptimizedResponse(`Line range patch committed: ${res.data.commit.sha}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_commit', {
    description: 'Get commit details by SHA.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), commit_sha: z.string() },
    annotations: getToolAnnotations('get_commit')
  }, async (args: any) => {
    const { owner, repo, commit_sha } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.getCommit({ owner: target.owner, repo: target.repo, ref: commit_sha });
      return formatOptimizedResponse({ sha: res.data.sha, message: res.data.commit.message });
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_label', {
    description: 'Get details of an issue label.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), name: z.string() },
    annotations: getToolAnnotations('get_label')
  }, async (args: any) => {
    const { owner, repo, name } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.issues.getLabel({ owner: target.owner, repo: target.repo, name });
      return formatOptimizedResponse(res.data);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_release', {
    description: 'Get a release. Omit `tag` for the latest published release, or pass it to fetch a specific one.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), tag: z.string().optional() },
    annotations: getToolAnnotations('get_release')
  }, async (args: any) => {
    const { owner, repo, tag } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = tag
        ? await octokit.repos.getReleaseByTag({ owner: target.owner, repo: target.repo, tag })
        : await octokit.repos.getLatestRelease({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse({ tag: res.data.tag_name, name: res.data.name, body: res.data.body });
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_tag', {
    description: 'Get tag object details.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), tag_sha: z.string() },
    annotations: getToolAnnotations('get_tag')
  }, async (args: any) => {
    const { owner, repo, tag_sha } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.git.getTag({ owner: target.owner, repo: target.repo, tag_sha });
      return formatOptimizedResponse(res.data);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_team_members', {
    description: 'List members of an organization team.',
    inputSchema: { org: z.string(), team_slug: z.string() },
    annotations: getToolAnnotations('get_team_members')
  }, async (args: any) => {
    const { org, team_slug } = args;
    try {
      const res = await octokit.teams.listMembersInOrg({ org, team_slug });
      return formatOptimizedResponse(res.data.map(m => m.login));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('get_teams', {
    description: 'List teams in an organization.',
    inputSchema: { org: z.string() },
    annotations: getToolAnnotations('get_teams')
  }, async (args: any) => {
    const { org } = args;
    try {
      const res = await octokit.teams.list({ org });
      return formatOptimizedResponse(res.data.map(t => ({ id: t.id, name: t.name, slug: t.slug })));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_branches', {
    description: 'List repository branches.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_branches')
  }, async (args: any) => {
    const { owner, repo, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.listBranches({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(b => `${b.name} (${b.commit.sha.substring(0, 7)})`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_commits', {
    description: 'List recent commits, filterable server-side by path/author/date range.',
    inputSchema: {
      owner: z.string().optional(), repo: z.string().optional(),
      sha: z.string().optional(),
      path: z.string().optional(),
      author: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().optional().default(5)
    },
    annotations: getToolAnnotations('list_commits')
  }, async (args: any) => {
    const { owner, repo, sha, path, author, since, until, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.listCommits({ owner: target.owner, repo: target.repo, sha, path, author, since, until, per_page: limit });
      return formatOptimizedResponse(res.data.map(c => `- ${c.sha.substring(0, 7)}: ${c.commit.message.split('\n')[0]}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_issue_fields', {
    description: 'List custom issue fields.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_issue_fields')
  }, async (args: any) => {
    const { owner, repo } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.issues.listLabelsForRepo({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(res.data.map(l => l.name));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_issue_types', {
    description: "List configured issue types.",
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_issue_types')
  }, async (args: any) => {
    const { owner, repo } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.request('GET /orgs/{org}/issue-types', { org: target.owner });
      return formatOptimizedResponse(res.data.map((t: any) => t.name));
    } catch (err: any) {
      if (err?.status === 404) return formatOptimizedResponse(['Bug', 'Feature', 'Task', 'Improvement']);
      return handleGitHubError(err);
    }
  });

  reg('list_issues', {
    description: 'List issues in repo.',
    inputSchema: {
      owner: z.string().optional(), repo: z.string().optional(),
      state: z.enum(['open', 'closed', 'all']).default('open'),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      creator: z.string().optional(),
      milestone: z.string().optional(),
      sort: z.enum(['created', 'updated', 'comments']).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
      since: z.string().optional(),
      limit: z.number().optional().default(10)
    },
    annotations: getToolAnnotations('list_issues')
  }, async (args: any) => {
    const { owner, repo, state, labels, assignee, creator, milestone, sort, direction, since, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.issues.listForRepo({
        owner: target.owner, repo: target.repo, state,
        labels: labels?.join(','), assignee, creator, milestone, sort, direction, since,
        per_page: limit
      });
      return formatOptimizedResponse(res.data.map(i => `#${i.number} [${i.state}]: ${i.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_pull_requests', {
    description: 'List pull requests.',
    inputSchema: {
      owner: z.string().optional(), repo: z.string().optional(),
      state: z.enum(['open', 'closed', 'all']).default('open'),
      head: z.string().optional(),
      base: z.string().optional(),
      sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
      limit: z.number().optional().default(10)
    },
    annotations: getToolAnnotations('list_pull_requests')
  }, async (args: any) => {
    const { owner, repo, state, head, base, sort, direction, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.list({ owner: target.owner, repo: target.repo, state, head, base, sort, direction, per_page: limit });
      return formatOptimizedResponse(res.data.map(p => `#${p.number} [${p.state}]: ${p.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_releases', {
    description: 'List releases.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('list_releases')
  }, async (args: any) => {
    const { owner, repo, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.listReleases({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(r => `${r.tag_name}: ${r.name || 'Untitled'}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_repository_collaborators', {
    description: 'List collaborators.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('list_repository_collaborators')
  }, async (args: any) => {
    const { owner, repo } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.listCollaborators({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(res.data.map(c => `${c.login} (${c.permissions?.admin ? 'admin' : 'write'})`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('list_tags', {
    description: 'List git tags.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(10) },
    annotations: getToolAnnotations('list_tags')
  }, async (args: any) => {
    const { owner, repo, limit } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.listTags({ owner: target.owner, repo: target.repo, per_page: limit });
      return formatOptimizedResponse(res.data.map(t => `${t.name} -> ${t.commit.sha.substring(0, 7)}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('issue_read', {
    description: 'Read detailed issue information.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), issue_number: z.number() },
    annotations: getToolAnnotations('issue_read')
  }, async (args: any) => {
    const { owner, repo, issue_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const issue = await octokit.issues.get({ owner: target.owner, repo: target.repo, issue_number });
      return formatOptimizedResponse({ number: issue.data.number, title: issue.data.title, body: issue.data.body, state: issue.data.state });
    } catch (err) { return handleGitHubError(err); }
  });

  reg('pull_request_read', {
    description: 'Read detailed pull request.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('pull_request_read')
  }, async (args: any) => {
    const { owner, repo, pull_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number });
      return formatOptimizedResponse({ number: res.data.number, title: res.data.title, state: res.data.state, mergeable: res.data.mergeable });
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_code', {
    description: 'Search code across repositories.',
    inputSchema: { q: z.string(), owner: z.string().optional(), repo: z.string().optional(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_code')
  }, async (args: any) => {
    const { q, owner, repo, limit } = args;
    try {
      let query = q;
      if (owner && repo) query += ` repo:${owner}/${repo}`;
      else {
        const ctx = getSessionContext(sessionId);
        if (ctx.owner && ctx.repo) query += ` repo:${ctx.owner}/${ctx.repo}`;
      }
      const res = await octokit.search.code({ q: query, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(i => `${i.repository.full_name}:${i.path}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_commits', {
    description: 'Search commits.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_commits')
  }, async (args: any) => {
    const { q, limit } = args;
    try {
      const res = await octokit.search.commits({ q, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(c => `${c.sha.substring(0, 7)}: ${c.commit.message.split('\n')[0]}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_issues', {
    description: 'Search issues.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_issues')
  }, async (args: any) => {
    const { q, limit } = args;
    try {
      const res = await octokit.search.issuesAndPullRequests({ q: `${q} is:issue`, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(i => `#${i.number}: ${i.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_pull_requests', {
    description: 'Search pull requests.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_pull_requests')
  }, async (args: any) => {
    const { q, limit } = args;
    try {
      const res = await octokit.search.issuesAndPullRequests({ q: `${q} is:pr`, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(p => `PR #${p.number}: ${p.title}`).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_repositories', {
    description: 'Search repositories or list user/org repos. Set exact:true to return only the single best match (use when the user wants one specific repo). Returns compact name + default branch only.',
    inputSchema: {
      q: z.string().optional().describe('Search query term or keywords'),
      username: z.string().optional().describe('GitHub username or org to fetch repositories for'),
      regex: z.string().optional().describe('Regex pattern to filter matching repository names'),
      exact: z.boolean().optional().default(false).describe('Return only the single best-matching repository'),
      page: z.number().optional().default(1).describe('Page number (1-indexed)'),
      limit: z.number().optional().default(20).describe('Items per page (default 20, max 20)')
    },
    annotations: getToolAnnotations('search_repositories')
  }, async (args: any) => {
    const { q, username, regex, exact, page, limit } = args;
    try {
      const perPage = Math.min(Math.max(1, limit || 20), 20);
      const pageNum = Math.max(1, page || 1);
      let items: any[] = [];
      let totalCount = 0;

      let rx: RegExp | null = null;
      if (regex) {
        try { rx = new RegExp(regex, 'i'); } catch {}
      }

      if (username) {
        if (q || rx) {
          // A filter was requested: pull a broad page of the user's repos and
          // filter client-side, since GitHub's listForUser has no free-text query.
          // Otherwise q/regex only reordered results without narrowing them.
          const userRepos = await octokit.repos.listForUser({
            username,
            per_page: 100,
            sort: 'updated'
          });
          items = userRepos.data || [];

          if (rx) {
            items = items.filter(r => rx!.test(r.name) || rx!.test(r.full_name));
          }
          if (q) {
            const needle = q.toLowerCase();
            items = items.filter(r =>
              r.name.toLowerCase().includes(needle) ||
              (r.description || '').toLowerCase().includes(needle)
            );
          }

          totalCount = items.length;
          const start = (pageNum - 1) * perPage;
          items = items.slice(start, start + perPage);
        } else {
          // No filter: an explicit "list everything" request, paginate normally.
          const userRepos = await octokit.repos.listForUser({
            username,
            per_page: perPage,
            page: pageNum,
            sort: 'updated'
          });
          items = userRepos.data || [];
          totalCount = items.length;
        }
      } else {
        const queryStr = q || 'is:public';
        const res = await octokit.search.repos({
          q: queryStr,
          per_page: perPage,
          page: pageNum
        });
        items = res.data.items || [];
        totalCount = res.data.total_count || items.length;

        if (rx) {
          items = items.filter(r => rx!.test(r.name) || rx!.test(r.full_name));
        }
      }

      if (items.length === 0) {
        return formatOptimizedResponse('No repositories found matching criteria.');
      }

      const targetQuery = q || regex || '';
      if (targetQuery) {
        items.forEach(r => {
          r._sim = getSimilarity(r.name, targetQuery);
        });
        items.sort((a, b) => (b._sim || 0) - (a._sim || 0));
      }

      const line = (r: any) => `${r.full_name} (${r.default_branch || 'main'})`;

      if (exact) {
        const top = items[0];
        return formatOptimizedResponse(line(top));
      }

      const formatted = items.map((r, i) => `${i + 1}. ${line(r)}`);
      const meta = `Page ${pageNum} (${formatted.length}/${totalCount} shown).`;
      return formatOptimizedResponse(`${meta}\n${formatted.join('\n')}`, 100000);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('search_users', {
    description: 'Search users.',
    inputSchema: { q: z.string(), limit: z.number().optional().default(5) },
    annotations: getToolAnnotations('search_users')
  }, async (args: any) => {
    const { q, limit } = args;
    try {
      const res = await octokit.search.users({ q, per_page: limit });
      return formatOptimizedResponse(res.data.items.map(u => u.login).join('\n'));
    } catch (err) { return handleGitHubError(err); }
  });

  reg('run_secret_scanning', {
    description: 'Run secret scanning check.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('run_secret_scanning')
  }, async (args: any) => {
    const { owner, repo } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.secretScanning.listAlertsForRepo({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(`Secret Scanning: Found ${res.data.length} active alerts.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('add_comment_to_pending_review', {
    description: 'Add line comment to pending review.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), body: z.string(), path: z.string(), line: z.number(), commit_id: z.string().optional() },
    annotations: getToolAnnotations('add_comment_to_pending_review')
  }, async (args: any) => {
    const { owner, repo, pull_number, body, path, line, commit_id } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      let activeCommitId = commit_id;
      if (!activeCommitId) {
        const pr = await octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number });
        activeCommitId = pr.data.head.sha;
      }
      const res = await octokit.pulls.createReviewComment({
        owner: target.owner, repo: target.repo, pull_number, body, path, line, commit_id: activeCommitId
      });
      return formatOptimizedResponse(`Comment ID: ${res.data.id}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('add_issue_comment', {
    description: 'Add comment to issue or PR.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), issue_number: z.number(), body: z.string() },
    annotations: getToolAnnotations('add_issue_comment')
  }, async (args: any) => {
    const { owner, repo, issue_number, body } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.issues.createComment({ owner: target.owner, repo: target.repo, issue_number, body });
      return formatOptimizedResponse(`Comment added #${issue_number}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('add_reply_to_pull_request_comment', {
    description: 'Reply to PR comment.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), comment_id: z.number(), body: z.string() },
    annotations: getToolAnnotations('add_reply_to_pull_request_comment')
  }, async (args: any) => {
    const { owner, repo, pull_number, comment_id, body } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.createReplyForReviewComment({ owner: target.owner, repo: target.repo, pull_number, comment_id, body });
      return formatOptimizedResponse(`Reply submitted ID: ${res.data.id}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('create_branch', {
    description: 'Create branch.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string(), refSha: z.string() },
    annotations: getToolAnnotations('create_branch')
  }, async (args: any) => {
    const { owner, repo, branch, refSha } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.git.createRef({ owner: target.owner, repo: target.repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatOptimizedResponse(`Branch '${branch}' created.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('delete_branch', {
    description: 'Delete a repository branch.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string() },
    annotations: getToolAnnotations('delete_branch')
  }, async (args: any) => {
    const { owner, repo, branch } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.git.deleteRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}` });
      return formatOptimizedResponse(`Branch '${branch}' deleted.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('create_or_update_file', {
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
  }, async (args: any) => {
    const { owner, repo, path, content, content_b64, message, branch, sha } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const activeBranch = branch || getSessionContext(sessionId).branch || 'main';
      const text = resolveInputString(content, content_b64);
      let activeSha = sha;
      if (!activeSha) {
        try {
          const existing = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: activeBranch });
          if (!Array.isArray(existing.data) && 'sha' in existing.data) activeSha = existing.data.sha;
        } catch {}
      }
      const res = await octokit.repos.createOrUpdateFileContents({
        owner: target.owner, repo: target.repo, path, message, content: Buffer.from(text, 'utf-8').toString('base64'), branch: activeBranch, sha: activeSha
      });
      return formatOptimizedResponse(`Committed SHA: ${res.data.commit.sha}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('create_pull_request', {
    description: 'Create pull request.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main') },
    annotations: getToolAnnotations('create_pull_request')
  }, async (args: any) => {
    const { owner, repo, title, body, head, base } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.create({ owner: target.owner, repo: target.repo, title, body, head, base });
      return formatOptimizedResponse(`PR #${res.data.number} created.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('create_repository', {
    description: 'Create new repo.',
    inputSchema: { name: z.string(), private: z.boolean().default(true), description: z.string().optional() },
    annotations: getToolAnnotations('create_repository')
  }, async (args: any) => {
    const { name, private: isPrivate, description } = args;
    try {
      const res = await octokit.repos.createForAuthenticatedUser({ name, private: isPrivate, description });
      updateSessionContext(sessionId, { owner: res.data.owner.login, repo: res.data.name });
      return formatOptimizedResponse(`Repo created: ${res.data.full_name}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('delete_file', {
    description: 'Delete file.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string() },
    annotations: getToolAnnotations('delete_file')
  }, async (args: any) => {
    const { owner, repo, path, message, sha, branch } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.repos.deleteFile({ owner: target.owner, repo: target.repo, path, message, sha, branch });
      return formatOptimizedResponse(`Deleted ${path}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('fork_repository', {
    description: 'Fork repo.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional() },
    annotations: getToolAnnotations('fork_repository')
  }, async (args: any) => {
    const { owner, repo } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.repos.createFork({ owner: target.owner, repo: target.repo });
      return formatOptimizedResponse(`Forked to ${res.data.full_name}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('issue_write', {
    description: 'Create or update issue.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), title: z.string(), body: z.string().optional(), issue_number: z.number().optional() },
    annotations: getToolAnnotations('issue_write')
  }, async (args: any) => {
    const { owner, repo, title, body, issue_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      if (issue_number) {
        const res = await octokit.issues.update({ owner: target.owner, repo: target.repo, issue_number, title, body });
        return formatOptimizedResponse(`Issue #${res.data.number} updated.`);
      } else {
        const res = await octokit.issues.create({ owner: target.owner, repo: target.repo, title, body });
        return formatOptimizedResponse(`Issue #${res.data.number} created.`);
      }
    } catch (err) { return handleGitHubError(err); }
  });

  reg('merge_pull_request', {
    description: 'Merge PR.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('merge_pull_request')
  }, async (args: any) => {
    const { owner, repo, pull_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.merge({ owner: target.owner, repo: target.repo, pull_number });
      return formatOptimizedResponse(`Merged PR #${pull_number}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('pull_request_review_write', {
    description: 'Submit PR review.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), body: z.string().optional() },
    annotations: getToolAnnotations('pull_request_review_write')
  }, async (args: any) => {
    const { owner, repo, pull_number, event, body } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.pulls.createReview({ owner: target.owner, repo: target.repo, pull_number, event, body });
      return formatOptimizedResponse(`Review submitted ID: ${res.data.id}`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('push_files', {
    description: 'Batch push multiple files.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string(), message: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) },
    annotations: getToolAnnotations('push_files')
  }, async (args: any) => {
    const { owner, repo, branch, message, files } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      for (const f of files) {
        let existingSha: string | undefined;
        try {
          const cur = await octokit.repos.getContent({ owner: target.owner, repo: target.repo, path: f.path, ref: branch });
          if (!Array.isArray(cur.data) && 'sha' in cur.data) existingSha = cur.data.sha;
        } catch {}
        await octokit.repos.createOrUpdateFileContents({
          owner: target.owner, repo: target.repo, path: f.path, message, content: Buffer.from(f.content).toString('base64'), branch, sha: existingSha
        });
      }
      return formatOptimizedResponse(`Pushed ${files.length} files.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('request_copilot_review', {
    description: 'Trigger a GitHub Copilot code review on a pull request.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('request_copilot_review')
  }, async (args: any) => {
    const { owner, repo, pull_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.pulls.requestReviewers({ owner: target.owner, repo: target.repo, pull_number, reviewers: ['copilot-pull-request-reviewer[bot]'] });
      return formatOptimizedResponse(`Copilot review requested for PR #${pull_number}.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('assign_copilot_to_issue', {
    description: 'Assign GitHub Copilot coding agent to an issue so it works the task autonomously.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), issue_number: z.number() },
    annotations: getToolAnnotations('assign_copilot_to_issue')
  }, async (args: any) => {
    const { owner, repo, issue_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.issues.addAssignees({ owner: target.owner, repo: target.repo, issue_number, assignees: ['copilot-swe-agent[bot]'] });
      return formatOptimizedResponse(`Copilot assigned to issue #${issue_number}.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('sub_issue_write', {
    description: 'Create sub-issue.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), parent_issue_number: z.number(), title: z.string(), body: z.string().optional() },
    annotations: getToolAnnotations('sub_issue_write')
  }, async (args: any) => {
    const { owner, repo, parent_issue_number, title, body } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      const res = await octokit.issues.create({ owner: target.owner, repo: target.repo, title: `[Sub-issue #${parent_issue_number}] ${title}`, body });
      return formatOptimizedResponse(`Sub-issue #${res.data.number} created.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('update_pull_request', {
    description: 'Update PR details.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number(), title: z.string().optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional() },
    annotations: getToolAnnotations('update_pull_request')
  }, async (args: any) => {
    const { owner, repo, pull_number, title, body, state } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.pulls.update({ owner: target.owner, repo: target.repo, pull_number, title, body, state });
      return formatOptimizedResponse(`PR #${pull_number} updated.`);
    } catch (err) { return handleGitHubError(err); }
  });

  reg('update_pull_request_branch', {
    description: 'Update PR branch with base.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), pull_number: z.number() },
    annotations: getToolAnnotations('update_pull_request_branch')
  }, async (args: any) => {
    const { owner, repo, pull_number } = args;
    try {
      const target = resolveRepo(owner, repo, sessionId);
      await octokit.pulls.updateBranch({ owner: target.owner, repo: target.repo, pull_number });
      return formatOptimizedResponse(`PR #${pull_number} branch updated.`);
    } catch (err) { return handleGitHubError(err); }
  });
}

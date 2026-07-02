import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

// Format successful response schemas
const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }]
});

// Format err response schemas
const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

// Decodes and captures rate limit status from GitHub API errors
function handleGitHubError(err: any): any {
  if (err?.status === 403 && err?.headers?.['x-ratelimit-remaining'] === '0') {
    const resetTime = err.headers['x-ratelimit-reset'] 
      ? new Date(parseInt(err.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString() 
      : 'soon';
    return formatError(new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`));
  }
  return formatError(err);
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}

interface RenderSessionEntry {
  sessionId: string;
  lastActive: number;
}

const transports = new Map<string, SessionEntry>();
const renderSessions = new Map<string, RenderSessionEntry>();

// Calculates text matching similarity via standard edit distance ratios
function getSimilarity(s1: string, s2: string): number {
  let longer = s1;
  let shorter = s2;
  if (s1.length < s2.length) {
    longer = s2;
    shorter = s1;
  }
  const longerLength = longer.length;
  if (longerLength === 0) {
    return 1.0;
  }
  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

// Compute string edit distance
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
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }
  return costs[s2.length];
}

// Employs sliding window search to assist on fuzzy typos
function getBestMatchFeedback(content: string, oldStr: string): string {
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');
  const n = contentLines.length;
  const m = oldLines.length;
  let bestRatio = 0;
  let bestStartIdx = -1;
  let bestEndIdx = -1;
  if (!oldStr.trim()) {
    return "Error: target old_str is blank.";
  }
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
    return `Error: The code block to replace was not found exactly.\n\n` +
           `Closest match found (similarity ${(bestRatio * 100).toFixed(1)}%):\n` +
           `-----------------------------------------\n` +
           `${closestSnippet.join('\n')}\n` +
           `-----------------------------------------\n\n` +
           `Check your formatting, indentation and brackets inside old_str precisely.`;
  }
  return "Error: Code block was not found. Check target file parameters and try again.";
}

// Safely run regular expression matches across lines using Node's VM module with a hard timeout to prevent ReDoS
function findMatchedLines(lines: string[], pattern: string, flags: string, timeoutMs: number = 200): number[] {
  const context = {
    lines,
    pattern,
    flags,
    matchedIndices: [] as number[],
    error: null as any
  };

  try {
    const code = `
      try {
        const rx = new RegExp(pattern, flags);
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            matchedIndices.push(i);
          }
        }
      } catch (e) {
        error = e;
      }
    `;
    vm.runInNewContext(code, context, { timeout: timeoutMs });
    if (context.error) {
      throw context.error;
    }
    return context.matchedIndices;
  } catch (err: any) {
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`Regex matching timed out (potential ReDoS detected).`);
    }
    throw err;
  }
}

// Fast mapping generator to fetch code layouts without opening massive files
function extractFileOutline(content: string, filePath: string): string {
  const lines = content.split('\n');
  const outline: string[] = [];
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const trimmed = lines[idx].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    if (['ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'cpp', 'h', 'java', 'cs', 'php'].includes(ext)) {
      if (trimmed.startsWith('import ') || trimmed.startsWith('export import ')) {
        if (outline.length === 0 || !outline[outline.length - 1].includes('import ')) {
          outline.push(`L${lineNum}: import ...`);
        }
      } else if (/^(export\s+)?(class|interface|type|enum|struct)\b/.test(trimmed)) {
        outline.push(`L${lineNum}: ${trimmed.split('{')[0].split('=')[0].trim()}`);
      } else if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(\([^)]*\)|[^=]+)\s*=>/.test(trimmed)) {
        const match = trimmed.match(/^(export\s+)?(const|let|var)\s+(\w+)/);
        if (match) {
          outline.push(`L${lineNum}: const ${match[3]} = (...) =>`);
        }
      } else if (/^(export\s+)?(async\s+)?function\s+(\w+)/.test(trimmed)) {
        outline.push(`L${lineNum}: ${trimmed.split('{')[0].trim()}`);
      } else if (trimmed.startsWith('func ') || trimmed.startsWith('pub fn ') || trimmed.startsWith('fn ')) {
        outline.push(`L${lineNum}: ${trimmed.split('{')[0].trim()}`);
      } else if (/^(public|private|protected|static|async)\s+/.test(trimmed) && trimmed.includes('(') && trimmed.includes(')')) {
        outline.push(`L${lineNum}: [Method] ${trimmed.split('{')[0].trim()}`);
      }
    } else if (ext === 'py') {
      if (trimmed.startsWith('def ') || trimmed.startsWith('class ')) {
        const indentCount = lines[idx].search(/\S/);
        const prefix = '  '.repeat(Math.floor(indentCount / 4));
        outline.push(`L${lineNum}: ${prefix}${trimmed.replace(/:$/, '')}`);
      }
    } else if (ext === 'rb') {
      if (trimmed.startsWith('def ') || trimmed.startsWith('class ') || trimmed.startsWith('module ')) {
        outline.push(`L${lineNum}: ${trimmed}`);
      }
    } else if (ext === 'json') {
      if (trimmed.startsWith('"') && trimmed.includes(':')) {
        const key = trimmed.split(':')[0].trim();
        outline.push(`L${lineNum}: ${key}: ...`);
      }
    }
  }
  return outline.length > 0 
    ? outline.join('\n') 
    : "No major declarations found inside this file.";
}

// Launch session validation against the Render platform API
async function initializeRenderSession(renderToken: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${renderToken}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'github-lean-agent-proxy',
            version: '1.2.0'
          }
        }
      })
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to initialize Render MCP session: ${errText}`);
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error('Render MCP server did not return an mcp-session-id header.');
    }
    try {
      await fetch('https://mcp.render.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${renderToken}`,
          'Mcp-Session-Id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        })
      });
    } catch {}
    return sessionId;
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Fetch cached or retrieve fresh Render session
async function getOrInitializeRenderSession(renderToken: string): Promise<string> {
  const cached = renderSessions.get(renderToken);
  if (cached) {
    cached.lastActive = Date.now();
    return cached.sessionId;
  }
  const session = await initializeRenderSession(renderToken);
  renderSessions.set(renderToken, { sessionId: session, lastActive: Date.now() });
  return session;
}

// Proxy tool calling handler for Render services
async function callRenderTool(toolName: string, args: any, renderToken: string | undefined) {
  if (!renderToken) {
    return formatError(new Error('Missing Render API key. Verify your environment variables.'));
  }
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const sessionId = await getOrInitializeRenderSession(renderToken);
      const response = await fetch('https://mcp.render.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${renderToken}`,
          'Mcp-Session-Id': sessionId
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args
          },
          id: `proxy-${toolName}`
        })
      });
      if (response.status === 400 || response.status === 401 || !response.ok) {
        const errText = await response.text();
        if (errText.includes('session') || errText.includes('Session') || response.status === 400) {
          renderSessions.delete(renderToken);
          if (attempts < 2) {
            continue;
          }
        }
        return formatError(new Error(`Render MCP Error: ${errText}`));
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return formatError(new Error(`Render MCP returned invalid JSON: ${response.status}`));
      }
      if (data?.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        if (errMsg.includes('session') || errMsg.includes('Session')) {
          renderSessions.delete(renderToken);
          if (attempts < 2) {
            continue;
          }
        }
        return formatError(new Error(errMsg));
      }
      return data?.result || data;
    } catch (err: any) {
      renderSessions.delete(renderToken);
      if (attempts >= 2) {
        return formatError(err);
      }
    }
  }
  return formatError(new Error('Render MCP call failed.'));
}

// Safely parse JSON blocks out of raw strings or objects
function extractJsonResult(rawResult: any): any {
  if (rawResult.isError) return null;
  let contentText = '';
  if (rawResult.content && Array.isArray(rawResult.content)) {
    contentText = rawResult.content[0]?.text || '';
  } else {
    contentText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
  }
  try {
    return JSON.parse(contentText);
  } catch {
    const match = contentText.match(/(\[([\s\S]*?)\]|\{([\s\S]*?)\})/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
  }
  return null;
}

// Generate the MCP server containing highly precise development and system tools
function createMcpServer(octokitClient: Octokit, renderToken: string | undefined) {
  const server = new McpServer({
    name: 'github-lean-agent',
    version: '1.2.0',
  });

  // Get details of active authorized user
  server.registerTool('get_viewer', {
    description: 'Get authenticated user profile details.',
    inputSchema: {}
  }, async () => {
    try {
      const res = await octokitClient.users.getAuthenticated();
      return formatSuccess(`${res.data.login} (${res.data.name || ''})`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Retrieves user repositories with strict page limitations
  server.registerTool('list_repos', {
    description: 'List user repositories. Returns clean layout to prevent context-bloat.',
    inputSchema: {
      limit: z.number().optional().default(5).describe('Repository results count (max 100)'),
      page: z.number().optional().default(1).describe('Active results page index')
    }
  }, async ({ limit, page }) => {
    try {
      const targetLimit = Math.min(limit, 100);
      const res = await octokitClient.repos.listForAuthenticatedUser({ 
        sort: 'updated', 
        per_page: targetLimit,
        page: page
      });
      if (res.data.length === 0) {
        return formatSuccess('No repositories found.');
      }
      const formatted = res.data.map(r => 
        `- ${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''} (Updated: ${r.updated_at ? r.updated_at.split('T')[0] : 'N/A'})`
      ).join('\n');
      const meta = `Page ${page}. Showing ${res.data.length} repositories.`;
      return formatSuccess(`${meta}\n\n${formatted}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Searches repositories matching target patterns
  server.registerTool('search_repos', {
    description: 'Find user repositories matching search patterns.',
    inputSchema: {
      q: z.string().describe('Target search string'),
      limit: z.number().optional().default(5).describe('Maximum matching listings returning (max 50)')
    }
  }, async ({ q, limit }) => {
    try {
      const targetLimit = Math.min(limit, 50);
      const res = await octokitClient.repos.listForAuthenticatedUser({ per_page: 100 });
      const lowerQ = q.toLowerCase();
      let matched = res.data.filter(r => 
        r.name.toLowerCase().includes(lowerQ) || r.full_name.toLowerCase().includes(lowerQ)
      ).slice(0, targetLimit);
      if (matched.length === 0) {
        const globalRes = await octokitClient.search.repos({ q: `${q} in:name`, per_page: targetLimit });
        matched = globalRes.data.items as any[];
      }
      if (matched.length === 0) {
        return formatSuccess('No matching repositories found.');
      }
      const formatted = matched.map(r => 
        `- ${r.full_name} [${r.default_branch}]${r.private ? ' (private)' : ''}`
      ).join('\n');
      return formatSuccess(formatted);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Gets branches inside specified repositories
  server.registerTool('list_branches', {
    description: 'List branches of a repository.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      limit: z.number().optional().default(5).describe('Branches result cap (max 50)'),
      page: z.number().optional().default(1).describe('Pagination index offset')
    }
  }, async ({ owner, repo, limit, page }) => {
    try {
      const targetLimit = Math.min(limit, 50);
      const res = await octokitClient.repos.listBranches({ 
        owner, 
        repo, 
        per_page: targetLimit,
        page: page
      });
      if (res.data.length === 0) {
        return formatSuccess('No branches found.');
      }
      const listWithShas = res.data.map(b => `${b.name}: ${b.commit.sha}`).join('\n');
      const meta = `Page ${page}. Showing ${res.data.length} branches.`;
      return formatSuccess(`${meta}\n\n${listWithShas}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Locate matching files using fast GitHub indexing queries
  server.registerTool('search_code', {
    description: 'Find files matching search criteria across codebases using GitHub indexes.',
    inputSchema: {
      q: z.string().describe('Search query pattern'),
      owner: z.string().optional().describe('Target code owner scope'),
      repo: z.string().optional().describe('Target codebase scope'),
      limit: z.number().optional().default(3).describe('Maximum files (max 20)'),
      fragmentLines: z.number().optional().default(3).describe('Context lines displaying (max 10)')
    }
  }, async ({ q, owner, repo, limit, fragmentLines }) => {
    try {
      let query = q;
      if (owner && repo) {
        query += ` repo:${owner}/${repo}`;
      }
      const targetLimit = Math.min(limit, 20);
      const targetFragmentLines = Math.min(fragmentLines, 10);
      const res = await octokitClient.search.code({
        q: query,
        per_page: targetLimit,
        headers: {
          accept: 'application/vnd.github.v3.text-match+json'
        }
      });
      if (!res.data.items || res.data.items.length === 0) {
        return formatSuccess('No code matches found.');
      }
      const results = res.data.items.map(item => {
        let text = `File: ${item.repository.full_name}:${item.path}\n`;
        const matches = (item as any).text_matches;
        if (matches && Array.isArray(matches) && matches.length > 0) {
          const match = matches[0];
          const fragmented = match.fragment.split('\n');
          const slicedFragment = fragmented.slice(0, targetFragmentLines).join('\n');
          text += `Match Segment:\n${slicedFragment}\n`;
          if (fragmented.length > targetFragmentLines) {
            text += `... (+${fragmented.length - targetFragmentLines} lines omitted)\n`;
          }
        } else {
          text += `(File matched search query criteria)\n`;
        }
        return text;
      }).join('\n---\n\n');
      return formatSuccess(results);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Perform pattern search across directories or within a single file safely (mitigated ReDoS loop)
  server.registerTool('grep', {
    description: 'High-performance pattern search. If a direct file path is specified, it will scan the file directly to bypass search indexing delays. Otherwise, scans recursively.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      pattern: z.string().describe('Regex or string sequence to look for.'),
      path: z.string().optional().describe('Optional file or directory scope limit. If a file is targeted, index searches are bypassed.'),
      glob: z.string().optional().describe('Glob pattern filter (e.g. "*.ts", "**/*.tsx"). Only evaluated during recursive search.'),
      type: z.string().optional().describe('File type filter extension (e.g. "py", "rs", "ts"). Only evaluated during recursive search.'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content').describe('Result format: "files_with_matches" returns paths, "content" returns matched lines, "count" returns counts.'),
      case_insensitive: z.boolean().optional().default(true).describe('Case-insensitive match execution.'),
      show_line_numbers: z.boolean().optional().default(true).describe('Prefix lines with line offsets.'),
      context_before: z.number().optional().default(2).describe('Reference lines before each match (min 0, max 10).'),
      context_after: z.number().optional().default(2).describe('Reference lines after each match (min 0, max 10).'),
      ref: z.string().optional().default('main').describe('Git tree reference.'),
      limit: z.number().optional().default(10).describe('Max files to download or max single-file matches to return (min 1, max 30).'),
      offset: z.number().optional().default(0).describe('Pagination offset. Only evaluated during single-file scan results.')
    }
  }, async ({ owner, repo, pattern, path: targetPath, glob, type, output_mode, case_insensitive, show_line_numbers, context_before, context_after, ref, limit, offset }) => {
    try {
      const maxFilesToProcess = Math.min(limit || 10, 30);
      const beforeCount = Math.min(Math.max(0, context_before ?? 2), 10);
      const afterCount = Math.min(Math.max(0, context_after ?? 2), 10);
      
      let isSingleFile = false;
      let rawContent = '';
      
      // Attempt direct file retrieval if a specific target path is passed
      if (targetPath) {
        try {
          const fileRes = await octokitClient.repos.getContent({
            owner,
            repo,
            path: targetPath,
            ref
          });
          if (fileRes.data && !Array.isArray(fileRes.data) && 'content' in fileRes.data) {
            rawContent = Buffer.from(fileRes.data.content, 'base64').toString('utf-8');
            isSingleFile = true;
          }
        } catch {
          // If 404, we assume it is a directory path or not yet created, falling back to search API
        }
      }

      const regexFlags = case_insensitive ? 'i' : '';

      // Execute direct single file grep if single file was successfully retrieved
      if (isSingleFile && targetPath) {
        const lines = rawContent.split('\n');
        let matchedIndices: number[] = [];
        try {
          // Sandbox context run with 500ms timeout for the single file process
          matchedIndices = findMatchedLines(lines, pattern, regexFlags, 500);
        } catch (err: any) {
          if (err.message?.includes('timed out')) {
            return formatError(new Error(`Grep aborted: potential ReDoS detected (execution timed out).`));
          }
          // If regex creation failed (syntax errors), fallback to precise substring literal lookup
          const lowerPattern = pattern.toLowerCase();
          lines.forEach((lineText, idx) => {
            const lowerLine = lineText.toLowerCase();
            const matched = case_insensitive ? lowerLine.includes(lowerPattern) : lineText.includes(pattern);
            if (matched) matchedIndices.push(idx);
          });
        }

        if (matchedIndices.length === 0) {
          return formatSuccess('No matched patterns found inside the target file.');
        }

        if (output_mode === 'files_with_matches') {
          return formatSuccess(`Matching target path:\n- ${targetPath}`);
        }

        if (output_mode === 'count') {
          return formatSuccess(`File: ${targetPath} - ${matchedIndices.length} matches`);
        }

        const total = matchedIndices.length;
        const slicedIndices = matchedIndices.slice(offset, offset + maxFilesToProcess);
        const results: string[] = [];
        let fileOut = `File: ${targetPath}\n`;
        const processedLines = new Set<number>();

        slicedIndices.forEach((matchIdx) => {
          const startIdx = Math.max(0, matchIdx - beforeCount);
          const endIdx = Math.min(lines.length - 1, matchIdx + afterCount);
          for (let i = startIdx; i <= endIdx; i++) {
            if (processedLines.has(i)) {
              continue;
            }
            processedLines.add(i);
            const prefix = i === matchIdx ? '>> ' : '   ';
            const numPrefix = show_line_numbers ? `L${i + 1} | ` : '';
            fileOut += `${prefix}${numPrefix}${lines[i]}\n`;
          }
        });

        results.push(fileOut.trimEnd());
        let meta = `Matches ${offset + 1}-${Math.min(offset + maxFilesToProcess, total)} of ${total} lines.`;
        if (total > offset + maxFilesToProcess) {
          meta += ` Re-run with offset: ${offset + maxFilesToProcess} to view subsequent segments.`;
        }
        return formatSuccess(`[METADATA: ${meta}]\n\n${results.join('\n')}`);
      }

      // Execute recursive search branch if no single file was targeted
      let query = pattern;
      query += ` repo:${owner}/${repo}`;
      if (targetPath) {
        query += ` path:${targetPath}`;
      }
      if (type) {
        query += ` extension:${type}`;
      }
      const searchRes = await octokitClient.search.code({
        q: query,
        per_page: maxFilesToProcess
      });
      let items = searchRes.data.items || [];
      if (glob) {
        const globLower = glob.toLowerCase().replace(/\*/g, '');
        items = items.filter(item => item.path.toLowerCase().includes(globLower));
      }
      if (items.length === 0) {
        return formatSuccess('No matching code files found.');
      }
      if (output_mode === 'files_with_matches') {
        const fileList = items.map(item => `- ${item.path}`).join('\n');
        return formatSuccess(`Matching files (limit: ${maxFilesToProcess}):\n\n${fileList}`);
      }
      const results: string[] = [];
      const filesToProcess = items.slice(0, maxFilesToProcess);
      for (const item of filesToProcess) {
        try {
          const fileContentRes = await octokitClient.repos.getContent({
            owner,
            repo,
            path: item.path,
            ref
          });
          if ('content' in fileContentRes.data && typeof fileContentRes.data.content === 'string') {
            const rawContentFile = Buffer.from(fileContentRes.data.content, 'base64').toString('utf-8');
            const lines = rawContentFile.split('\n');
            let matchedIndices: number[] = [];
            try {
              // Sandbox context run with 200ms timeout per scanned file
              matchedIndices = findMatchedLines(lines, pattern, regexFlags, 200);
            } catch (err: any) {
              if (err.message?.includes('timed out')) {
                return formatError(new Error(`Grep aborted: potential ReDoS detected in file ${item.path} (execution timed out).`));
              }
              // Fallback to literal search if regex compiles with errors
              const lowerPattern = pattern.toLowerCase();
              lines.forEach((lineText, idx) => {
                const lowerLine = lineText.toLowerCase();
                const matched = case_insensitive ? lowerLine.includes(lowerPattern) : lineText.includes(pattern);
                if (matched) matchedIndices.push(idx);
              });
            }
            if (matchedIndices.length > 0) {
              if (output_mode === 'count') {
                results.push(`File: ${item.path} - ${matchedIndices.length} matches`);
              } else {
                let fileOut = `File: ${item.path}\n`;
                const processedLines = new Set<number>();
                matchedIndices.forEach((idx) => {
                  const startIdx = Math.max(0, idx - beforeCount);
                  const endIdx = Math.min(lines.length - 1, idx + afterCount);
                  for (let i = startIdx; i <= endIdx; i++) {
                    if (processedLines.has(i)) {
                      continue;
                    }
                    processedLines.add(i);
                    const prefix = i === idx ? '>> ' : '   ';
                    const numPrefix = show_line_numbers ? `L${i + 1} | ` : '';
                    fileOut += `${prefix}${numPrefix}${lines[i]}\n`;
                  }
                });
                results.push(fileOut.trimEnd());
              }
            }
          }
        } catch {}
      }
      if (results.length === 0) {
        return formatSuccess('No matched patterns found inside the matching files.');
      }
      return formatSuccess(results.join('\n\n=========================================\n\n'));
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Pull recursive repository tree details
  server.registerTool('get_tree', {
    description: 'Retrieve file path paths tree index recursively.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      tree_sha: z.string().default('main').describe('Branch, tag, or commit SHA'),
      offset: z.number().optional().default(0).describe('Pagination offset index'),
      limit: z.number().optional().default(50).describe('Maximum items displaying in index output (max 200)'),
      q: z.string().optional().describe('Keyword folder structure match filter')
    }
  }, async ({ owner, repo, tree_sha, offset, limit, q }) => {
    try {
      const res = await octokitClient.git.getTree({ owner, repo, tree_sha, recursive: 'true' });
      let tree = res.data.tree;
      if (q) {
        const lowerQ = q.toLowerCase();
        tree = tree.filter(t => (t.path || '').toLowerCase().includes(lowerQ));
      }
      const total = tree.length;
      const targetLimit = Math.min(limit, 200);
      const items = tree.slice(offset, offset + targetLimit).map(t => 
        `${t.type === 'tree' ? '[D]' : '[F]'} ${t.path}`
      );
      let out = items.join('\n');
      let meta = `Showing items ${offset + 1}-${Math.min(offset + targetLimit, total)} of ${total} paths.`;
      if (total > offset + targetLimit) {
        meta += ` Re-run with offset: ${offset + targetLimit} for more.`;
      }
      return formatSuccess(`${meta}\n\n${out || 'No paths located matching folder filter.'}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Read file segments mapping line numbers prefixing by default
  server.registerTool('get_contents', {
    description: 'Read file lines. Automatically attaches line number prefixes for precision targeting.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path'),
      ref: z.string().default('main').describe('Commit, branch or tag ref'),
      startLine: z.number().optional().default(1).describe('Starting coordinate (1-based index)'),
      limit: z.number().optional().default(100).describe('Lines displaying (default 100, max 500)'),
      endLine: z.number().optional().describe('Ending coordinate. Overrides limit bounds up to 500 lines.')
    }
  }, async ({ owner, repo, path, ref, startLine, limit, endLine }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        const total = lines.length;
        let start = Math.max(1, startLine);
        let targetLimit = Math.min(Math.max(1, limit), 500);
        if (endLine) {
          const calculatedLimit = endLine - start + 1;
          if (calculatedLimit > 0) {
            targetLimit = Math.min(calculatedLimit, 500);
          }
        }
        let end = Math.min(total, start + targetLimit - 1);
        if (start > total) {
          return formatError(new Error(`startLine ${startLine} is larger than file length ${total}`));
        }
        const windowLines = lines.slice(start - 1, end);
        const out = windowLines.map((line, idx) => {
          const lineNum = start + idx;
          return `${lineNum.toString().padStart(5, ' ')} | ${line}`;
        }).join('\n');
        let meta = `Lines ${start}-${end} of ${total} total lines.`;
        if (total > end) {
          meta += ` File truncated. Fetch again with startLine: ${end + 1} to view subsequent segments.`;
        }
        return formatSuccess(`[METADATA: ${meta}]\n\n${out}`);
      }
      return formatSuccess('Not a file');
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Pull high-level file declarations without loading entire code segments
  server.registerTool('view_file_outline', {
    description: 'Pull high-level symbol structures, structures, or definitions without loading raw contents.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path'),
      ref: z.string().default('main').describe('Target Git ref context')
    }
  }, async ({ owner, repo, path, ref }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const outline = extractFileOutline(raw, path);
        return formatSuccess(`--- FILE STRUCTURE OUTLINE: ${path} (${ref}) ---\n\n${outline}`);
      }
      return formatSuccess('Not a text file.');
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Surgical replacement editor resolving line differences dynamically
  server.registerTool('str_replace_editor', {
    description: 'Surgically search and replace a unique code block (old_str) with new code (new_str). Safe-checks uniqueness.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path'),
      branch: z.string().describe('Active git branch reference'),
      old_str: z.string().describe('Exact sequence of code lines to replace. Spacing/tabs must match exactly.'),
      new_str: z.string().describe('Replacement sequence block.'),
      message: z.string().describe('Commit message.'),
      sha: z.string().optional().describe('Git object SHA. Automatically fetched if omitted.')
    }
  }, async ({ owner, repo, path, branch, old_str, new_str, message, sha }) => {
    try {
      const fileData = await octokitClient.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) {
        throw new Error('Target is not a file.');
      }
      const rawContent = Buffer.from(fileData.data.content, 'base64').toString('utf-8');
      const targetSha = sha || fileData.data.sha;
      const normalizedContent = rawContent.replace(/\r\n/g, '\n');
      const normalizedOld = old_str.replace(/\r\n/g, '\n');
      const normalizedNew = new_str.replace(/\r\n/g, '\n');
      const occurrences = normalizedContent.split(normalizedOld).length - 1;
      if (occurrences === 0) {
        const feedback = getBestMatchFeedback(normalizedContent, normalizedOld);
        throw new Error(feedback);
      }
      if (occurrences > 1) {
        const occLineNumbers: number[] = [];
        const lines = normalizedContent.split('\n');
        const oldLines = normalizedOld.split('\n');
        for (let i = 0; i <= lines.length - oldLines.length; i++) {
          const chunk = lines.slice(i, i + oldLines.length).join('\n');
          if (chunk === normalizedOld) {
            occLineNumbers.push(i + 1);
          }
        }
        throw new Error(`The old_str block was found ${occurrences} times at starting lines: ${occLineNumbers.join(', ')}. Expand context limits in old_str to isolate targets.`);
      }
      const updatedContentNormalized = normalizedContent.replace(normalizedOld, normalizedNew);
      const hasCrLf = rawContent.includes('\r\n');
      const finalContent = hasCrLf 
        ? updatedContentNormalized.replace(/\n/g, '\r\n') 
        : updatedContentNormalized;
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(finalContent, 'utf-8').toString('base64'),
        branch,
        sha: targetSha
      });
      return formatSuccess(`Surgical replacement successful. Commit: ${res.data.commit.sha}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Create new files or fully write small files
  server.registerTool('put_contents', {
    description: 'Completely write or overwrite file contents. Best used to generate NEW files. For updates, prefer using str_replace_editor.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      branch: z.string(),
      sha: z.string().optional()
    }
  }, async ({ owner, repo, path, content, message, branch, sha }) => {
    try {
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(content, 'utf-8').toString('base64'), branch, sha
      });
      return formatSuccess(`Success: ${res.data.commit.sha}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Replace specified line ranges directly
  server.registerTool('patch_contents', {
    description: 'Replace specified line indices directly. Prefer using str_replace_editor to prevent overlapping index changes.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      branch: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      newContent: z.string(),
      message: z.string()
    }
  }, async ({ owner, repo, path, branch, startLine, endLine, newContent, message }) => {
    try {
      const fileData = await octokitClient.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(fileData.data) || !('content' in fileData.data)) throw new Error('Not a file');
      const lines = Buffer.from(fileData.data.content, 'base64').toString('utf-8').split('\n');
      if (startLine < 1 || endLine < startLine || endLine > lines.length) {
        throw new Error(`Invalid line coordinates. Target boundary has ${lines.length} lines.`);
      }
      lines.splice(startLine - 1, endLine - startLine + 1, ...newContent.split('\n'));
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(lines.join('\n'), 'utf-8').toString('base64'), branch, sha: fileData.data.sha
      });
      return formatSuccess(`Success: ${res.data.commit.sha}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Delete files from branches
  server.registerTool('delete_contents', {
    description: 'Delete files from repository branches.',
    inputSchema: {
      owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      await octokitClient.repos.deleteFile({ owner, repo, path, message, sha, branch });
      return formatSuccess(`Deleted ${path}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Create workspace branches
  server.registerTool('create_ref', {
    description: 'Create repository branches.',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string(), refSha: z.string()
    }
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      await octokitClient.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatSuccess(`Created branch ${branch}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Delete workspace branches
  server.registerTool('delete_ref', {
    description: 'Delete branches from repositories.',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, branch }) => {
    try {
      await octokitClient.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      return formatSuccess(`Deleted branch ${branch}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Open Pull Request references
  server.registerTool('create_pull', {
    description: 'Create pull requests between branches.',
    inputSchema: {
      owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main')
    }
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const res = await octokitClient.pulls.create({ owner, repo, title, body, head, base });
      return formatSuccess(`PR #${res.data.number} opened: ${res.data.html_url}`);
    } catch (err) {
      return handleGitHubError(err);
    }
  });

  // Fetch Render workspaces auto-defaulting single selections
  server.registerTool('list_workspaces', {
    description: 'List active workspaces. Auto-detects single user workspaces to bypass selection processes.',
    inputSchema: {}
  }, async (args) => {
    const rawResult = await callRenderTool('list_workspaces', args, renderToken);
    const parsed = extractJsonResult(rawResult);
    if (!parsed) return rawResult;
    try {
      const workspaces = Array.isArray(parsed) ? parsed : (parsed.workspaces || []);
      const simplified = workspaces.map((w: any) => ({
        id: w.id || w.workspace?.id,
        name: w.name || w.workspace?.name,
        personal: w.personal || w.workspace?.personal
      }));
      let autoSelectNote = "";
      if (simplified.length === 1) {
        autoSelectNote = `\n[AUTO-DEFAULT: Single active workspace isolated with OwnerID: ${simplified[0].id}]`;
      }
      return formatSuccess({ workspaces: simplified, meta: autoSelectNote.trim() });
    } catch {
      return rawResult;
    }
  });

  // Selection mapping configurations
  server.registerTool('select_workspace', {
    description: 'Set target active workspace ID.',
    inputSchema: {
      ownerID: z.string().describe('Target owner ID starts with tea- or own-.')
    }
  }, async (args) => {
    return callRenderTool('select_workspace', args, renderToken);
  });

  // Fetch target active workspace setup details
  server.registerTool('get_selected_workspace', {
    description: 'Get details for selected workspace.',
    inputSchema: {}
  }, async (args) => {
    return callRenderTool('get_selected_workspace', args, renderToken);
  });

  // Render services index with advanced substring filtering and default selectors
  server.registerTool('list_services', {
    description: 'Query active services. Isolate results by query parameter to bypass retrieving complete listings.',
    inputSchema: {
      q: z.string().optional().describe('Substring filters service name, ID, type, or repository URL to isolate targets.'),
      limit: z.number().optional().default(5).describe('Pagination index offset limit (max 50)'),
      offset: z.number().optional().default(0).describe('Pagination page offset index'),
      includePreviews: z.boolean().optional().default(false)
    }
  }, async ({ q, limit, offset, includePreviews }) => {
    const rawResult = await callRenderTool('list_services', { includePreviews }, renderToken);
    const parsed = extractJsonResult(rawResult);
    if (!parsed) return rawResult;
    try {
      let services = Array.isArray(parsed) ? parsed : [];
      if (!Array.isArray(services) && typeof parsed === 'object') {
        for (const k of Object.keys(parsed)) {
          if (Array.isArray(parsed[k])) {
            services = parsed[k];
            break;
          }
        }
      }
      if (q) {
        const lowerQ = q.toLowerCase();
        services = services.filter((s: any) => {
          const name = (s.name || s.service?.name || '').toLowerCase();
          const id = (s.id || s.service?.id || '').toLowerCase();
          const type = (s.type || s.service?.type || '').toLowerCase();
          const repo = (s.repo || s.service?.repo || s.service?.repoDetails?.url || '').toLowerCase();
          return name.includes(lowerQ) || id.includes(lowerQ) || type.includes(lowerQ) || repo.includes(lowerQ);
        });
      }
      const totalMatched = services.length;
      const targetLimit = Math.min(limit, 50);
      const paginated = services.slice(offset, offset + targetLimit);
      const simplified = paginated.map((s: any) => ({
        id: s.id || s.service?.id,
        name: s.name || s.service?.name,
        type: s.type || s.service?.type,
        state: s.state || s.service?.state,
        repo: s.repo || s.service?.repo || s.service?.repoDetails?.url
      }));
      let meta = `Matched ${paginated.length} of ${totalMatched} services.`;
      if (totalMatched === 1) {
        meta += ` [AUTO-DEFAULT: Single target service isolated. ID: ${simplified[0].id}]`;
      } else if (totalMatched > offset + targetLimit) {
        meta += ` Re-run with offset: ${offset + targetLimit} for next batch.`;
      }
      return formatSuccess({ meta, services: simplified });
    } catch (err: any) {
      return formatError(new Error(`Failed to query services: ${err.message}`));
    }
  });

  // Get details of specified service profiles
  server.registerTool('get_service', {
    description: 'Get configuration detail metrics of specified services.',
    inputSchema: {
      serviceId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_service', args, renderToken);
  });

  // Retrieve deployments history auto-detecting single items
  server.registerTool('list_deploys', {
    description: 'List deployments histories.',
    inputSchema: {
      serviceId: z.string(),
      limit: z.number().optional().default(3).describe('Deployments history log limit (max 20)'),
      offset: z.number().optional().default(0).describe('Pagination page offset index')
    }
  }, async ({ serviceId, limit, offset }) => {
    const targetLimit = Math.min(limit, 20);
    const rawResult = await callRenderTool('list_deploys', { serviceId, limit: offset + targetLimit }, renderToken);
    const parsed = extractJsonResult(rawResult);
    if (!parsed) return rawResult;
    try {
      let deploys = Array.isArray(parsed) ? parsed : [];
      if (!Array.isArray(deploys) && typeof parsed === 'object') {
        for (const k of Object.keys(parsed)) {
          if (Array.isArray(parsed[k])) {
            deploys = parsed[k];
            break;
          }
        }
      }
      const total = deploys.length;
      const paginated = deploys.slice(offset, offset + targetLimit);
      const simplified = paginated.map((d: any) => ({
        id: d.id || d.deploy?.id,
        status: d.status || d.deploy?.status,
        commitMessage: d.commit?.message || d.deploy?.commit?.message || 'N/A',
        createdAt: d.createdAt || d.deploy?.createdAt
      }));
      let meta = `Deployments ${offset + 1}-${Math.min(offset + targetLimit, total)} of ${total}.`;
      if (total === 1) {
        meta += ` [AUTO-DEFAULT: Only deployment found. ID: ${simplified[0].id}]`;
      }
      return formatSuccess({ meta, deploys: simplified });
    } catch (err: any) {
      return formatError(new Error(`Failed to query deployments: ${err.message}`));
    }
  });

  // Get details of specific deployments
  server.registerTool('get_deploy', {
    description: 'Get configuration layout details of specified deployments.',
    inputSchema: {
      serviceId: z.string(),
      deployId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_deploy', args, renderToken);
  });

  // Get active console log outputs trimming parameters to protect token bounds
  server.registerTool('list_logs', {
    description: 'Get console and service logs.',
    inputSchema: {
      resource: z.array(z.string()).describe('Array of resource IDs like srv-xxxx'),
      level: z.array(z.string()).optional().describe('Log severity levels'),
      type: z.array(z.string()).optional().describe('Log type classification'),
      instance: z.array(z.string()).optional(),
      host: z.array(z.string()).optional(),
      limit: z.number().optional().default(15).describe('Log entries cap (max 250)')
    }
  }, async (args) => {
    const requestedLimit = args.limit || 15;
    const targetLimit = Math.min(requestedLimit, 250);
    const payload = { ...args, limit: targetLimit };
    const rawResult = await callRenderTool('list_logs', payload, renderToken);
    const parsed = extractJsonResult(rawResult);
    if (!parsed) return rawResult;
    try {
      if (Array.isArray(parsed)) {
        const sliced = parsed.slice(0, targetLimit);
        const simplified = sliced.map((l: any) => {
          if (typeof l === 'string') return l.slice(0, 180);
          return {
            t: l.timestamp || l.time || l.t,
            lvl: l.level || l.lvl,
            msg: (l.message || l.msg || JSON.stringify(l)).trim().slice(0, 180)
          };
        });
        let truncatedNote = '';
        if (parsed.length > targetLimit) {
          truncatedNote = `\n... (truncated from ${parsed.length} lines)`;
        }
        return formatSuccess(JSON.stringify(simplified, null, 2) + truncatedNote);
      }
      return rawResult;
    } catch {
      return rawResult;
    }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '50mb' }));

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  if (!MCP_API_KEY) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server configuration error: MCP_API_KEY is not configured on host.' },
      id: req.body?.id || null
    });
    return;
  }
  const clientApiKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.toString().replace('Bearer ', '')
    || (req.query.api_key as string);
  
  if (clientApiKey !== MCP_API_KEY) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Invalid or missing MCP_API_KEY' },
      id: req.body?.id || null
    });
    return;
  }
  const githubToken = (req.headers['x-github-token'] as string) || DEFAULT_GITHUB_PAT;
  const renderToken = (req.headers['x-render-token'] as string)
    || (req.headers['x-render-api-key'] as string)
    || DEFAULT_RENDER_API_KEY;
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    entry.lastActive = Date.now();
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error?.message || 'Request Handling Error' },
          id: req.body?.id || null
        });
      }
    }
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => Math.random().toString(36).substring(2, 15),
    onsessioninitialized: (id) => {
      transports.set(id, { transport, lastActive: Date.now() });
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };

  const octokit = new Octokit({ auth: githubToken || '' });
  const server = createMcpServer(octokit, renderToken);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error?.message || 'Handshake Error' },
        id: req.body?.id || null
      });
    }
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('🚀 Stateless Unified MCP Server active.');
});

// Periodic session cleanup process
const timer = setInterval(() => {
  const now = Date.now();
  const maxIdleTime = 15 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdleTime) {
      try {
        if (typeof entry.transport.close === 'function') {
          entry.transport.close();
        }
      } catch {}
      transports.delete(id);
    }
  }
  for (const [token, entry] of renderSessions.entries()) {
    if (now - entry.lastActive > maxIdleTime) {
      renderSessions.delete(token);
    }
  }
}, 5 * 60 * 1000);
timer.unref();

const PORT = process.env.PORT || 3000;
const serverInstance = app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
});

// Handle graceful process shutdown
let isShuttingDown = false;

function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Received ${signal}. Initiating graceful shutdown sequence...`);
  clearInterval(timer);

  // Stop active transport sessions cleanly
  for (const [id, entry] of transports.entries()) {
    try {
      if (typeof entry.transport.close === 'function') {
        entry.transport.close();
      }
    } catch {}
    transports.delete(id);
  }

  // Define a watchdog timer to force exit if active connections fail to drain within 10 seconds
  const forceExitTimeout = setTimeout(() => {
    console.error('Forced shutdown: Active connections did not resolve in time.');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  serverInstance.close((err) => {
    clearTimeout(forceExitTimeout);
    if (err) {
      console.error('Error closing Express server:', err);
      process.exit(1);
    } else {
      console.log('Express server closed gracefully.');
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
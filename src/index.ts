import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

const formatSuccess = (data: any) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }]
});

const formatError = (error: any) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error?.message || String(error) }]
});

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

async function initializeRenderSession(renderToken: string): Promise<string> {
  const response = await fetch('https://mcp.render.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${renderToken}`
    },
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
}

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

async function callRenderTool(toolName: string, args: any, renderToken: string | undefined) {
  if (!renderToken) {
    return formatError(new Error('Missing Render API key. Please check your RENDER_API_KEY environment variable or headers.'));
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

function createMcpServer(octokitClient: Octokit, renderToken: string | undefined) {
  const server = new McpServer({
    name: 'github-lean-agent',
    version: '1.2.0',
  });

  server.registerTool('get_viewer', {
    description: 'Get authenticated user',
    inputSchema: {}
  }, async () => {
    try {
      const res = await octokitClient.users.getAuthenticated();
      return formatSuccess(`${res.data.login} (${res.data.name || ''})`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_repos', {
    description: 'List recent repositories. High-efficiency summary.',
    inputSchema: {
      limit: z.number().optional().default(5).describe('Number of repos to return (default 5, max 100)'),
      page: z.number().optional().default(1).describe('Page number for pagination')
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

      const meta = `Page ${page}. Displaying ${res.data.length} repos. Request next page for more.`;
      return formatSuccess(`${meta}\n\n${formatted}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('search_repos', {
    description: 'Search authenticated user repos or global repos. Concise summary format.',
    inputSchema: {
      q: z.string().describe('Search keyword or pattern'),
      limit: z.number().optional().default(5).describe('Max matches to display (default 5, max 50)')
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
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_branches', {
    description: 'List branches with abbreviated and full commit SHAs. Optimized summary.',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      limit: z.number().optional().default(5).describe('Number of branches to fetch (default 5, max 50)'),
      page: z.number().optional().default(1).describe('Page number for pagination')
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
      const meta = `Page ${page}. Showing ${res.data.length} branches. Query next page for more.`;
      
      return formatSuccess(`${meta}\n\n${listWithShas}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('search_code', {
    description: 'Search for code patterns across repositories. Returns highly condensed context chunks.',
    inputSchema: {
      q: z.string().describe('Search query keyword or code pattern'),
      owner: z.string().optional().describe('Optional repository owner to restrict search scope'),
      repo: z.string().optional().describe('Optional repository name to restrict search scope'),
      limit: z.number().optional().default(3).describe('Max code match files to return (default 3, max 20)'),
      fragmentLines: z.number().optional().default(8).describe('Number of lines of matching context fragment to display (default 8, max 50)')
    }
  }, async ({ q, owner, repo, limit, fragmentLines }) => {
    try {
      let query = q;
      if (owner && repo) {
        query += ` repo:${owner}/${repo}`;
      }
      const targetLimit = Math.min(limit, 20);
      const targetFragmentLines = Math.min(fragmentLines, 50);
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
          text += `Match Context (showing first ${targetFragmentLines} lines):\n${slicedFragment}\n`;
          if (fragmented.length > targetFragmentLines) {
            text += `... (+${fragmented.length - targetFragmentLines} lines omitted)\n`;
          }
        } else {
          text += `(No fragment match details returned; file exists)\n`;
        }
        return text;
      }).join('\n---\n\n');
      
      return formatSuccess(results);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('grep_file', {
    description: 'Search for a keyword or regex within a specific file to find matching lines and surrounding code context.',
    inputSchema: {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Path to the file'),
      query: z.string().describe('Keyword or text to search for'),
      ref: z.string().default('main').describe('Git branch, tag, or commit SHA'),
      limit: z.number().optional().default(15).describe('Maximum matching lines to return (default 15, max 100)'),
      offset: z.number().optional().default(0).describe('Starting match index for pagination'),
      contextLines: z.number().optional().default(0).describe('Number of surrounding context lines to show before and after each match (default 0, max 5).')
    }
  }, async ({ owner, repo, path, query, ref, limit, offset, contextLines }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const lines = raw.split('\n');
        
        const matchedIndices: number[] = [];
        const targetLimit = Math.min(limit, 100);
        const targetContext = Math.min(contextLines, 5);
        
        const testMatch = (line: string): boolean => {
          try {
            const regex = new RegExp(query, 'i');
            return regex.test(line);
          } catch {
            return line.toLowerCase().includes(query.toLowerCase());
          }
        };

        lines.forEach((line, index) => {
          if (testMatch(line)) {
            matchedIndices.push(index);
          }
        });
        
        if (matchedIndices.length === 0) {
          return formatSuccess('No matching lines found.');
        }
        
        const total = matchedIndices.length;
        const slicedIndices = matchedIndices.slice(offset, offset + targetLimit);
        
        const matchOutputs: string[] = [];
        slicedIndices.forEach((matchIdx) => {
          if (targetContext === 0) {
            matchOutputs.push(`L${matchIdx + 1}: ${lines[matchIdx].trim().slice(0, 150)}`);
          } else {
            const contextStart = Math.max(0, matchIdx - targetContext);
            const contextEnd = Math.min(lines.length - 1, matchIdx + targetContext);
            let block = `--- Match at Line ${matchIdx + 1} ---\n`;
            for (let i = contextStart; i <= contextEnd; i++) {
              const prefix = i === matchIdx ? '>> ' : '   ';
              block += `${prefix}L${i + 1}: ${lines[i].trim().slice(0, 150)}\n`;
            }
            matchOutputs.push(block.trimEnd());
          }
        });
        
        let out = matchOutputs.join(targetContext === 0 ? '\n' : '\n\n');
        let meta = `Showing matches ${offset + 1}-${Math.min(offset + targetLimit, total)} of ${total} total matching lines.`;
        if (total > offset + targetLimit) {
          meta += ` Re-run tool with offset: ${offset + targetLimit} for next batch.`;
        }
        
        return formatSuccess(`${meta}\n\n${out}`);
      }
      return formatSuccess('Not a file');
    } catch (err) { return formatError(err); }
  });

  server.registerTool('get_tree', {
    description: 'Get file tree. Slices tree listings with control options for paging size.',
    inputSchema: {
      owner: z.string().describe('Repository owner/organization'),
      repo: z.string().describe('Repository name'),
      tree_sha: z.string().default('main').describe('Git branch, tag, or commit SHA'),
      offset: z.number().optional().default(0).describe('Index offset for paginating deep trees (increments of limit)'),
      limit: z.number().optional().default(50).describe('Max items to show in single response (default 50, max 200)'),
      q: z.string().optional().describe('Search keyword to filter files by path/name')
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
      let meta = `Showing items ${offset + 1}-${Math.min(offset + targetLimit, total)} of ${total} total items.`;
      if (total > offset + targetLimit) {
        meta += ` Re-run tool with offset: ${offset + targetLimit} for more.`;
      }
      return formatSuccess(`${meta}\n\n${out || 'No files matches found.'}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('get_contents', {
    description: 'Read file contents inside a controlled safe window (default 300 lines, maximum 750 lines). Use startLine and limit or endLine to control segment size.',
    inputSchema: {
      owner: z.string().describe('Repository owner/organization'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Path to the file'),
      ref: z.string().default('main').describe('Git branch, tag, or commit SHA'),
      startLine: z.number().optional().default(1).describe('First line to read (1-based, inclusive)'),
      limit: z.number().optional().default(300).describe('Number of lines to return (default 300, max 750)'),
      endLine: z.number().optional().describe('Last line to read (inclusive). If specified, overrides the limit up to a max window of 750 lines.')
    }
  }, async ({ owner, repo, path, ref, startLine, limit, endLine }) => {
    try {
      const res = await octokitClient.repos.getContent({ owner, repo, path, ref });
      if ('content' in res.data && typeof res.data.content === 'string') {
        const raw = Buffer.from(res.data.content, 'base64').toString('utf-8');
        let lines = raw.split('\n');
        const total = lines.length;
        
        let start = Math.max(1, startLine);
        let targetLimit = Math.min(Math.max(1, limit), 750);
        
        if (endLine) {
          const calculatedLimit = endLine - start + 1;
          if (calculatedLimit > 0) {
            targetLimit = Math.min(calculatedLimit, 750);
          }
        }
        
        let end = Math.min(total, start + targetLimit - 1);
        
        if (start > total) {
          return formatError(new Error(`Invalid startLine: ${startLine}. Total lines in file: ${total}`));
        }
        
        let truncated = false;
        if (total > end) {
          truncated = true;
        }
        
        const windowLines = lines.slice(start - 1, end);
        let out = windowLines.join('\n');
        
        let meta = `Displaying lines ${start}-${end} of ${total} total lines.`;
        if (truncated) {
          meta += ` File is truncated. Call again with startLine: ${end + 1} to view subsequent segments.`;
        }
        
        return formatSuccess(`[METADATA: ${meta}]\n\n${out}`);
      }
      return formatSuccess('Not a file');
    } catch (err) { return formatError(err); }
  });

  server.registerTool('put_contents', {
    description: 'Write/overwrite file',
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
    } catch (err) { return formatError(err); }
  });

  server.registerTool('patch_contents', {
    description: 'Replace line range',
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
        throw new Error(`Invalid range. Lines: ${lines.length}`);
      }
      lines.splice(startLine - 1, endLine - startLine + 1, ...newContent.split('\n'));
      const res = await octokitClient.repos.createOrUpdateFileContents({
        owner, repo, path, message, content: Buffer.from(lines.join('\n'), 'utf-8').toString('base64'), branch, sha: fileData.data.sha
      });
      return formatSuccess(`Success: ${res.data.commit.sha}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('delete_contents', {
    description: 'Delete file',
    inputSchema: {
      owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), sha: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, path, message, sha, branch }) => {
    try {
      await octokitClient.repos.deleteFile({ owner, repo, path, message, sha, branch });
      return formatSuccess(`Deleted ${path}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('create_ref', {
    description: 'Create branch',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string(), refSha: z.string()
    }
  }, async ({ owner, repo, branch, refSha }) => {
    try {
      await octokitClient.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: refSha });
      return formatSuccess(`Created branch ${branch}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('delete_ref', {
    description: 'Delete branch',
    inputSchema: {
      owner: z.string(), repo: z.string(), branch: z.string()
    }
  }, async ({ owner, repo, branch }) => {
    try {
      await octokitClient.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      return formatSuccess(`Deleted branch ${branch}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('create_pull', {
    description: 'Create PR',
    inputSchema: {
      owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string().default('main')
    }
  }, async ({ owner, repo, title, body, head, base }) => {
    try {
      const res = await octokitClient.pulls.create({ owner, repo, title, body, head, base });
      return formatSuccess(`PR #${res.data.number} opened: ${res.data.html_url}`);
    } catch (err) { return formatError(err); }
  });

  server.registerTool('list_workspaces', {
    description: 'List accessible workspaces. Hyper-condensed output.',
    inputSchema: {}
  }, async (args) => {
    const rawResult = await callRenderTool('list_workspaces', args, renderToken);
    const parsed = extractJsonResult(rawResult);
    if (!parsed) return rawResult;

    try {
      let workspaces = Array.isArray(parsed) ? parsed : (parsed.workspaces || []);
      const simplified = workspaces.map((w: any) => ({
        id: w.id || w.workspace?.id,
        name: w.name || w.workspace?.name,
        personal: w.personal || w.workspace?.personal
      }));
      return formatSuccess({ workspaces: simplified });
    } catch {
      return rawResult;
    }
  });

  server.registerTool('select_workspace', {
    description: 'Select a workspace to use.',
    inputSchema: {
      ownerID: z.string().describe('The ID of the workspace to use (starts with tea- or own-).')
    }
  }, async (args) => {
    return callRenderTool('select_workspace', args, renderToken);
  });

  server.registerTool('get_selected_workspace', {
    description: 'Get the currently selected workspace.',
    inputSchema: {}
  }, async (args) => {
    return callRenderTool('get_selected_workspace', args, renderToken);
  });

  server.registerTool('list_services', {
    description: 'List, search, and paginate through Render services. Supports regex and substring searches matching names or connected repository URLs.',
    inputSchema: {
      q: z.string().optional().describe('Filter/search query. Supports case-insensitive substring or regex (e.g. "grumm" or "^web-"). Matches service name, id, type, or connected repository URL.'),
      limit: z.number().optional().default(3).describe('Number of items to return in this batch (default 3, max 50)'),
      offset: z.number().optional().default(0).describe('Zero-based offset for pagination'),
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

      // Filter locally with regex or simple substring fallback
      if (q) {
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(q, 'i');
        } catch {
          // Fallback to substring match if q is not a compilable regex pattern
        }

        services = services.filter((s: any) => {
          const name = s.name || s.service?.name || '';
          const id = s.id || s.service?.id || '';
          const type = s.type || s.service?.type || '';
          const repo = s.repo || s.service?.repo || s.service?.repoDetails?.url || '';

          if (regex) {
            return regex.test(name) || regex.test(id) || regex.test(type) || regex.test(repo);
          } else {
            const lowerQ = q.toLowerCase();
            return name.toLowerCase().includes(lowerQ) ||
                   id.toLowerCase().includes(lowerQ) ||
                   type.toLowerCase().includes(lowerQ) ||
                   repo.toLowerCase().includes(lowerQ);
          }
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
        updatedAt: s.updatedAt || s.service?.updatedAt,
        repo: s.repo || s.service?.repo || s.service?.repoDetails?.url
      }));

      let message = `Displaying ${paginated.length} of ${totalMatched} matched services.`;
      if (totalMatched > offset + targetLimit) {
        message += ` Re-run tool with offset: ${offset + targetLimit} to retrieve the next batch.`;
      }

      return formatSuccess({
        meta: message,
        services: simplified
      });
    } catch (err: any) {
      return formatError(new Error(`Failed to filter/paginate services: ${err.message}`));
    }
  });

  server.registerTool('get_service', {
    description: 'Get details about a specific service.',
    inputSchema: {
      serviceId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_service', args, renderToken);
  });

  server.registerTool('list_deploys', {
    description: 'List deploy history. Highly simplified metadata and paginated to save context limits.',
    inputSchema: {
      serviceId: z.string(),
      limit: z.number().optional().default(3).describe('Number of deployments to display (default 3, max 50)'),
      offset: z.number().optional().default(0).describe('Pagination offset')
    }
  }, async ({ serviceId, limit, offset }) => {
    const targetLimit = Math.min(limit, 50);
    const rawResult = await callRenderTool('list_deploys', { serviceId, limit: Math.max(offset + targetLimit, 20) }, renderToken);
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
        createdAt: d.createdAt || d.deploy?.createdAt,
        finishedAt: d.finishedAt || d.deploy?.finishedAt
      }));

      let meta = `Showing deployments ${offset + 1}-${Math.min(offset + targetLimit, total)} of ${total}.`;
      if (total > offset + targetLimit) {
        meta += ` For next batch, re-run with offset: ${offset + targetLimit}.`;
      }

      return formatSuccess({ meta, deploys: simplified });
    } catch (err: any) {
      return formatError(new Error(`Failed to parse deployments: ${err.message}`));
    }
  });

  server.registerTool('get_deploy', {
    description: 'Get deployment details.',
    inputSchema: {
      serviceId: z.string(),
      deployId: z.string()
    }
  }, async (args) => {
    return callRenderTool('get_deploy', args, renderToken);
  });

  server.registerTool('list_logs', {
    description: 'Get service logs. Slices long messages to protect token efficiency.',
    inputSchema: {
      resource: z.array(z.string()).describe('Filter logs by their resource (array of strings, e.g. ["srv-xxxx"])'),
      level: z.array(z.string()).optional().describe('Filter logs by severity level'),
      type: z.array(z.string()).optional().describe('Filter logs by type'),
      instance: z.array(z.string()).optional().describe('Filter logs by instance'),
      host: z.array(z.string()).optional().describe('Filter request logs by host'),
      limit: z.number().optional().default(15).describe('Maximum number of log lines to return (default 15, max 250)')
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
          truncatedNote = `\n... (truncated from ${parsed.length} items. Request larger limit if details are missing.)`;
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

setInterval(() => {
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
}, 5 * 60 * 1000).unref();

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
});
import express, { Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox } from './sandboxTools.js';
import { formatOptimizedResponse, getToolAnnotations, TOOL_CATEGORY, ToolCategory } from './security.js';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}
const transports = new Map<string, SessionEntry>();

/**
 * Lazy toolset loading — every tool still registers (same 80 names, same
 * schemas), but only the small 'core' set starts enabled. This keeps the
 * initial tools/list payload — and therefore every subsequent turn's token
 * cost — small for sessions that only touch one domain, while still letting
 * an agent reach everything with one `load_toolset` call.
 *
 * `github` is auto-enabled by default: `set_active_context` (core) strongly
 * implies GitHub work is imminent, so gating it behind an extra round-trip
 * would cost more than it saves for the overwhelmingly common case. `render`
 * and `sandbox` stay gated since a session might touch only one or neither.
 */
function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, category: ToolCategory) {
  for (const name of Object.keys(registry)) {
    if (!(name in categoryOf)) categoryOf[name] = TOOL_CATEGORY[name] || category;
  }
}

/** Each connection gets its own McpServer + isolated GitHub/sandbox session context, keyed by sessionId. */
function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string) {
  const server = new McpServer({
    name: 'unified-mcp-server',
    version: '3.1.0'
  });

  const octokit = new Octokit({ auth: githubToken || '' });

  const registry: Record<string, any> = {};
  const categoryOf: Record<string, ToolCategory> = {};

  registerGitHubTools(server, octokit, sessionId, registry);
  tagCategory(registry, categoryOf, 'github');
  registerRenderTools(server, () => renderToken, registry);
  tagCategory(registry, categoryOf, 'render');
  registerSandboxTools(server, sessionId, githubToken, registry);
  tagCategory(registry, categoryOf, 'sandbox');

  for (const [name, handle] of Object.entries(registry)) {
    const cat = categoryOf[name];
    if (cat === 'render' || cat === 'sandbox') handle.disable();
  }

  server.registerTool('load_toolset', {
    description: "Enable a gated toolset for this session: 'render' (deploys/logs/env vars/postgres) or 'sandbox' (git clone/exec/run/push). GitHub tools are already enabled by default. Pass 'all' to enable everything at once.",
    inputSchema: { category: z.enum(['render', 'sandbox', 'all']) },
    annotations: getToolAnnotations('load_toolset')
  }, async (args: any) => {
    const wanted: ToolCategory[] = args.category === 'all' ? ['github', 'render', 'sandbox'] : [args.category];
    const justEnabled: string[] = [];
    for (const [name, handle] of Object.entries(registry)) {
      if (wanted.includes(categoryOf[name]) && !handle.enabled) {
        handle.enable();
        justEnabled.push(name);
      }
    }
    return formatOptimizedResponse(justEnabled.length ? { enabled: justEnabled } : { note: 'Requested toolset(s) already enabled.' });
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '50mb' }));

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  if (!MCP_API_KEY) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP_API_KEY missing on server.' },
      id: req.body?.id || null
    });
    return;
  }

  const clientKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.toString().replace('Bearer ', '')
    || (req.query.api_key as string);

  if (clientKey !== MCP_API_KEY) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized API Key.' },
      id: req.body?.id || null
    });
    return;
  }

  const githubToken = (req.headers['x-github-token'] as string) || DEFAULT_GITHUB_PAT || '';
  const renderToken = (req.headers['x-render-token'] as string) || DEFAULT_RENDER_API_KEY;
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    entry.lastActive = Date.now();
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message }, id: req.body?.id || null });
      }
    }
    return;
  }

  // Generate the session id ourselves *before* connecting, so the same id can be
  // threaded into the GitHub/sandbox tool registrars for per-connection isolation.
  const newSessionId = crypto.randomUUID();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (id) => {
      transports.set(id, { transport, lastActive: Date.now() });
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      destroySandbox(transport.sessionId);
      transports.delete(transport.sessionId);
    }
  };

  const masterServer = createMasterServer(githubToken, renderToken, newSessionId);
  try {
    await masterServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message }, id: req.body?.id || null });
    }
  }
});

app.get('/', (_req, res) => {
  res.send('⚡ Unified Ephemeral MCP Gateway Active.');
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 10 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) {
      destroySandbox(id);
      try { entry.transport.close(); } catch { /* noop */ }
      transports.delete(id);
    }
  }
}, 3 * 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Gateway Active on Port ${PORT}`));

function shutdown() {
  clearInterval(cleanupTimer);
  for (const [id] of transports.entries()) destroySandbox(id);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

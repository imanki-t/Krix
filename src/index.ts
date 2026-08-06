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
import {
  formatOptimizedResponse, getToolAnnotations, TOOL_CATEGORY, ToolCategory,
  identityKey, getEnabledCategories, persistEnabledCategory, cleanupIdleIdentities
} from './security.js';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}
const transports = new Map<string, SessionEntry>();

function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, fallbackCategory: ToolCategory) {
  for (const name of Object.keys(registry)) {
    categoryOf[name] = TOOL_CATEGORY[name] || fallbackCategory;
  }
}

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string, identity: string) {
  const server = new McpServer({
    name: 'krix',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {
        listChanged: true
      }
    }
  });

  const octokit = new Octokit({ auth: githubToken || '' });

  const registry: Record<string, any> = {};
  const categoryOf: Record<string, ToolCategory> = {};

  registerGitHubTools(server, octokit, sessionId, registry);
  tagCategory(registry, categoryOf, 'github_admin');
  
  registerRenderTools(server, () => renderToken, registry);
  tagCategory(registry, categoryOf, 'render');
  
  registerSandboxTools(server, sessionId, githubToken, registry);
  tagCategory(registry, categoryOf, 'sandbox');

  // Re-enable any category already unlocked for this caller identity, disable others
  const persistedCats = getEnabledCategories(identity);
  for (const [name, handle] of Object.entries(registry)) {
    const cat = categoryOf[name];
    if (persistedCats.has(cat)) {
      handle.enable();
    } else {
      handle.disable();
    }
  }

  server.registerTool('load_toolset', {
    description: "Enable lazy toolsets: 'github_issues_prs' (issue/PR reviews/comments), 'github_admin' (teams/releases/collaborators), 'sandbox' (git clone/exec/run/push), or 'render' (deploys/logs/env/postgres). Pass 'all' to enable everything.",
    inputSchema: { category: z.enum(['github_issues_prs', 'github_admin', 'sandbox', 'render', 'all']) },
    annotations: getToolAnnotations('load_toolset')
  }, async (args: any) => {
    persistEnabledCategory(identity, args.category);

    const wanted: ToolCategory[] = args.category === 'all'
      ? ['core', 'github_issues_prs', 'github_admin', 'sandbox', 'render']
      : [args.category];

    const justEnabled: string[] = [];
    for (const [name, handle] of Object.entries(registry)) {
      if (wanted.includes(categoryOf[name]) && !handle.enabled) {
        handle.enable();
        justEnabled.push(name);
      }
    }

    try {
      await server.sendToolListChanged();
    } catch {}

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
  const callerIdentity = identityKey(githubToken);
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

  const masterServer = createMasterServer(githubToken, renderToken, newSessionId, callerIdentity);
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
  res.send('⚡ Krix Gateway Active.');
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 10 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) {
      destroySandbox(id);
      try { entry.transport.close(); } catch {}
      transports.delete(id);
    }
  }
  cleanupIdleIdentities(24 * 60 * 60 * 1000);
}, 3 * 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Krix Active on Port ${PORT}`));

function shutdown() {
  clearInterval(cleanupTimer);
  for (const [id] of transports.entries()) destroySandbox(id);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

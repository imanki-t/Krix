import express, { Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox, cleanupSessionResources } from './sandboxTools.js';
import {
  formatOptimizedResponse, getToolAnnotations, TOOL_CATEGORY, ToolCategory, getSessionContext, registerSessionAuth, getAuthKeyForSession, RESOURCE_LIMITS
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

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string) {
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

  const ctx = getSessionContext(sessionId);
  for (const [name, handle] of Object.entries(registry)) {
    const cat = categoryOf[name];
    if (ctx.enabledCategories.has(cat)) {
      handle.enable();
    } else {
      handle.disable();
    }
  }

  return server;
}

const app = express();
app.use(express.json({ limit: RESOURCE_LIMITS.maxRequestBodyBytes }));
app.use('/assets', express.static('assets'));
app.get('/logo.jpg', (_req, res) => res.sendFile(path.resolve('assets/logo.jpg')));

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  if (!MCP_API_KEY) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP_API_KEY missing on server.' },
      id: req.body?.id || null
    });
    return;
  }

  const authHeader = req.headers['authorization']?.toString() || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const clientKey = (req.headers['x-api-key'] as string) || bearer;
  const expected = Buffer.from(MCP_API_KEY);
  const provided = Buffer.from(clientKey || '');
  const validKey = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

  if (!validKey) {
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
      registerSessionAuth(sessionId, githubToken);
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message }, id: req.body?.id || null });
      }
    }
    return;
  }

  if (transports.size >= RESOURCE_LIMITS.maxSessions) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Krix session capacity reached. Wait for an idle session to expire and retry.' },
      id: req.body?.id || null
    });
    return;
  }

  const newSessionId = crypto.randomUUID();
  registerSessionAuth(newSessionId, githubToken);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (id) => {
      transports.set(id, { transport, lastActive: Date.now() });
    }
  });

  transport.onclose = () => {
    const closedId = transport.sessionId;
    if (!closedId) return;
    let closedAuth: string | undefined;
    try { closedAuth = getAuthKeyForSession(closedId); } catch {}
    transports.delete(closedId);
    if (!closedAuth) return; // Already cleaned up by the idle/shutdown path.
    const hasOtherSession = [...transports.keys()].some((id) => {
      try { return getAuthKeyForSession(id) === closedAuth; } catch { return false; }
    });
    // The sandbox is shared by auth identity. Only the final live session for
    // that identity may destroy the shared sandbox.
    if (hasOtherSession) cleanupSessionResources(closedId);
    else void destroySandbox(closedId);
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
  res.send('⚡ Krix Gateway Active.');
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 10 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) {
      const authKey = (() => { try { return getAuthKeyForSession(id); } catch { return undefined; } })();
      transports.delete(id);
      const hasOtherSession = authKey ? [...transports.keys()].some((otherId) => {
        try { return getAuthKeyForSession(otherId) === authKey; } catch { return false; }
      }) : false;
      if (hasOtherSession) cleanupSessionResources(id);
      else void destroySandbox(id);
      try { entry.transport.close(); } catch {}
    }
  }
}, 3 * 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Krix Active on Port ${PORT}`));

async function shutdown() {
  clearInterval(cleanupTimer);
  const uniqueAuths = new Set<string>();
  for (const [id] of transports.entries()) {
    try {
      const authKey = getAuthKeyForSession(id);
      if (!uniqueAuths.has(authKey)) {
        uniqueAuths.add(authKey);
        await destroySandbox(id);
      } else {
        cleanupSessionResources(id);
      }
    } catch {}
  }
  transports.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

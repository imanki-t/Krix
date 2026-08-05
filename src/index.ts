import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox } from './sandboxTools.js';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}
const transports = new Map<string, SessionEntry>();

function createMasterServer(githubToken: string, renderToken?: string) {
  const server = new McpServer({
    name: 'unified-mcp-server',
    version: '2.5.0'
  });

  const octokit = new Octokit({ auth: githubToken || '' });

  registerGitHubTools(server, octokit);
  registerRenderTools(server, () => renderToken);
  registerSandboxTools(server);

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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => Math.random().toString(36).substring(2, 15),
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

  const masterServer = createMasterServer(githubToken, renderToken);
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
      try { entry.transport.close(); } catch {}
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
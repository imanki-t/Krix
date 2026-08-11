import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';

import { connectDB } from './services/db.js';
import { loadSettings, loadToolPolicy } from './config/settings.js';
import { registerGitHubTools } from './tools/githubTools.js';
import { registerRenderTools } from './tools/renderTools.js';
import { registerSandboxTools, destroySandbox } from './tools/sandboxTools.js';
import {
  formatOptimizedResponse, getToolAnnotations, TOOL_CATEGORY, ToolCategory,
  getSessionContext, updateSessionContext, deleteSessionContext
} from './core/security.js';
import { wellKnownRouter } from './routes/wellKnown.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';
import { settingsRouter } from './routes/settings.js';
import { oauthRouter } from './routes/oauth.js';
import { ApiKeyRepository } from './models/ApiKey.js';
import { UserRepository } from './models/User.js';
import { hashApiKey, decryptSecret } from './services/cryptoService.js';
import { AuditLogRepository } from './models/AuditLog.js';

dotenv.config();

connectDB().catch(console.error);

const settings = loadSettings();
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
      frameSrc: ["'self'", "https://accounts.google.com", "https://www.google.com/recaptcha/"],
      connectSrc: ["'self'", "https://accounts.google.com", "https://www.google.com/recaptcha/", "https://mcp.render.com", "https://api.github.com"],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-github-token', 'x-render-token', 'mcp-session-id'],
  maxAge: 600
}));

const globalLimiter = rateLimit({
  windowMs: settings.rateLimiting.globalWindowMs || 900000,
  max: settings.rateLimiting.globalMaxRequests || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before retrying.' }
});
app.use(globalLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '500kb' }));
app.use(cookieParser());

app.use(wellKnownRouter);
app.use('/web', express.static(path.resolve(process.cwd(), 'src/web')));
app.use('/public', express.static(path.resolve(process.cwd(), 'public')));

app.use('/api/auth', authRouter);
app.use('/api/auth/oauth', oauthRouter);
app.use('/oauth', oauthRouter);
app.use('/api/keys', keysRouter);
app.use('/api/settings', settingsRouter);

app.get('/api/health', (req: Request, res: Response): void => {
  res.json({
    status: 'healthy',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
  userId?: string;
  keyHash?: string;
}
const transports = new Map<string, SessionEntry>();

function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, fallbackCategory: ToolCategory) {
  for (const name of Object.keys(registry)) {
    if (registry[name]) {
      categoryOf[name] = TOOL_CATEGORY[name] || fallbackCategory;
    }
  }
}

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string) {
  const server = new McpServer({
    name: 'krix',
    version: '2.0.0'
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
    if (!handle) continue;
    const cat = categoryOf[name];
    if (ctx.enabledCategories.has(cat) || ctx.enabledToolOverrides.has(name)) {
      handle.enable();
    } else {
      handle.disable();
    }
  }

  server.registerTool('load_toolset', {
    description: "Lazily unlock specific toolset categories for this session: 'github_issues_prs' (issues/PRs), 'github_admin' (teams/releases/collaborators), 'sandbox' (code execution/git CLI), or 'render' (deployments/logs/postgres). Pass 'all' to unlock everything.",
    inputSchema: {
      category: z.enum(['github_issues_prs', 'github_admin', 'sandbox', 'render', 'all']).describe('Category of tools to activate.')
    },
    annotations: getToolAnnotations('load_toolset')
  }, async (args: any) => {
    const currentCtx = getSessionContext(sessionId);
    if (args.category === 'all') {
      const allCats: ToolCategory[] = ['core', 'github_issues_prs', 'github_admin', 'sandbox', 'render'];
      allCats.forEach(c => currentCtx.enabledCategories.add(c));
    } else {
      currentCtx.enabledCategories.add(args.category as ToolCategory);
    }

    const wanted: ToolCategory[] = args.category === 'all'
      ? ['core', 'github_issues_prs', 'github_admin', 'sandbox', 'render']
      : [args.category];

    const justEnabled: string[] = [];
    for (const [name, handle] of Object.entries(registry)) {
      if (handle && wanted.includes(categoryOf[name]) && !handle.enabled) {
        handle.enable();
        justEnabled.push(name);
      }
    }

    try {
      await server.sendToolListChanged();
    } catch {}

    return formatOptimizedResponse(justEnabled.length ? { activatedCategory: args.category, enabledTools: justEnabled } : { note: `Toolset '${args.category}' already active.` });
  });

  return server;
}

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  const clientKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.toString().replace(/^Bearer\s+/i, '');

  if (!clientKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Missing API Key. Provide x-api-key header or Bearer token.' },
      id: req.body?.id || null
    });
    return;
  }

  let effectiveGithubToken = (req.headers['x-github-token'] as string) || process.env.DEFAULT_GITHUB_PAT || '';
  let effectiveRenderToken = (req.headers['x-render-token'] as string) || process.env.DEFAULT_RENDER_API_KEY;
  let authenticatedUserId: string | undefined;
  let keyHash: string | undefined;

  const masterDevKey = process.env.MCP_MASTER_API_KEY;
  if (!masterDevKey) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server misconfiguration: MCP_MASTER_API_KEY not set.' },
      id: req.body?.id || null
    });
    return;
  }
  if (masterDevKey && clientKey.length === masterDevKey.length && crypto.timingSafeEqual(Buffer.from(clientKey), Buffer.from(masterDevKey))) {
    // Master dev key
  } else {
    keyHash = hashApiKey(clientKey);
    const keyDoc = await ApiKeyRepository.findByHash(keyHash);
    if (!keyDoc) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized API Key.' },
        id: req.body?.id || null
      });
      return;
    }

    authenticatedUserId = keyDoc.userId;
    ApiKeyRepository.recordUsage(keyHash).catch(() => {});

    const user = await UserRepository.findById(keyDoc.userId);
    if (user) {
      if (user.encryptedGithubPat && !req.headers['x-github-token']) {
        effectiveGithubToken = decryptSecret(user.encryptedGithubPat);
      }
      if (user.encryptedRenderKey && !req.headers['x-render-token']) {
        effectiveRenderToken = decryptSecret(user.encryptedRenderKey);
      }
    }
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    entry.lastActive = Date.now();
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: req.body?.id || null });
      }
    }
    return;
  }

  const newSessionId = crypto.randomUUID();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (id) => {
      transports.set(id, { transport, lastActive: Date.now(), userId: authenticatedUserId, keyHash });
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      destroySandbox(transport.sessionId);
      transports.delete(transport.sessionId);
    }
  };

  const masterServer = createMasterServer(effectiveGithubToken, effectiveRenderToken, newSessionId);
  try {
    await masterServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: req.body?.id || null });
    }
  }
});

const indexHtmlPath = path.resolve(process.cwd(), 'src/web/index.html');

app.get([
  '/',
  '/login',
  '/signup',
  '/dashboard',
  '/dashboard/:subpage',
  '/dashboard/:subpage/:section',
  '/docs',
  '/policy',
  '/privacy',
  '/terms'
], (req: Request, res: Response): void => {
  if (fs.existsSync(indexHtmlPath)) {
    res.setHeader('Content-Type', 'text/html');
    fs.createReadStream(indexHtmlPath).pipe(res);
  } else {
    res.send('⚡ Krix Gateway Active.');
  }
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 15 * 60 * 1000;
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
const server = app.listen(PORT, () => {
  console.log(`🚀 Krix Enterprise Gateway active on Port ${PORT}`);
  console.log(`📡 MCP Streamable HTTP: http://localhost:${PORT}/mcp`);
  console.log(`🌐 Web Portal & Console: http://localhost:${PORT}`);
});

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  server.close(() => {
    console.log('HTTP server closed.');
    clearInterval(cleanupTimer);
    // Destroy all active sandboxes
    for (const [id] of transports.entries()) {
      destroySandbox(id);
    }
    transports.clear();
    process.exit(0);
  });
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 30000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  gracefulShutdown('uncaughtException');
});

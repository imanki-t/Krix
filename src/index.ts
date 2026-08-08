import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox } from './sandboxTools.js';
import { oauthAuthorize, oauthAuthorizePost, oauthToken, oauthRegister, oauthRevoke, oauthMetadata, protectedResourceMetadata, resolveOAuthAccessToken } from './oauth.js';
import { TOOL_CATEGORY, ToolCategory, getSessionContext, registerSessionAuth, consumeRateLimit, timingSafeEqualText } from './security.js';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT.');
const MCP_API_KEY = process.env.MCP_API_KEY?.trim() || '';
const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT || '';
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const ALLOW_LEGACY_API_KEY = process.env.ALLOW_LEGACY_API_KEY === 'true';
const ALLOW_CLIENT_CREDENTIAL_HEADERS = process.env.ALLOW_CLIENT_CREDENTIAL_HEADERS === 'true';
const MAX_SESSIONS = Math.max(10, Number(process.env.MAX_MCP_SESSIONS || 100));
if (!Number.isFinite(MAX_SESSIONS) || MAX_SESSIONS > 5000) throw new Error('MAX_MCP_SESSIONS is invalid.');

if (isProduction) {
  if (!MCP_API_KEY || MCP_API_KEY.length < 32) throw new Error('MCP_API_KEY must be at least 32 characters in production.');
  if (!process.env.PUBLIC_BASE_URL?.startsWith('https://')) throw new Error('PUBLIC_BASE_URL=https://... is required in production.');
  if (process.env.ALLOW_LEGACY_API_KEY === 'true') console.warn('WARNING: ALLOW_LEGACY_API_KEY is enabled; prefer OAuth bearer tokens.');
  if (process.env.ALLOW_CLIENT_CREDENTIAL_HEADERS === 'true') console.warn('WARNING: client-supplied GitHub/Render credentials are enabled.');
  if (process.env.SANDBOX_MODE !== 'bwrap') console.warn('WARNING: SANDBOX_MODE is not bwrap. Arbitrary sandbox commands are not production-isolated.');
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
  authFingerprint: string;
  clientId: string;
}
const transports = new Map<string, SessionEntry>();

function fingerprint(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function requestId(req: Request): string { return String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 100); }
function clientIp(req: Request): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

function jsonRpcError(res: Response, status: number, message: string, id: unknown = null): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: id ?? null });
}

function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, fallbackCategory: ToolCategory) {
  for (const name of Object.keys(registry)) categoryOf[name] = TOOL_CATEGORY[name] || fallbackCategory;
}

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string) {
  const server = new McpServer({ name: 'krix', version: '2.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const octokit = new Octokit({ auth: githubToken || undefined });
  const registry: Record<string, any> = {};
  const categoryOf: Record<string, ToolCategory> = {};

  registerGitHubTools(server, octokit, sessionId, registry); tagCategory(registry, categoryOf, 'github_admin');
  registerRenderTools(server, () => renderToken, registry); tagCategory(registry, categoryOf, 'render');
  registerSandboxTools(server, sessionId, githubToken, registry); tagCategory(registry, categoryOf, 'sandbox');

  const ctx = getSessionContext(sessionId);
  for (const [name, handle] of Object.entries(registry)) {
    const cat = categoryOf[name];
    if (ctx.enabledCategories.has(cat)) handle.enable(); else handle.disable();
  }
  return server;
}

function securityHeaders(res: Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function allowedOrigins(): Set<string> {
  return new Set((process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
}

function validateOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = allowedOrigins();
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (origin === publicBase || allowed.has(origin)) return true;
  res.status(403).json({ error: 'Origin not allowed.' });
  return false;
}

function parseAuthorization(req: Request): { clientId: string; credential: string; fingerprint: string } | null {
  const auth = String(req.headers.authorization || '');
  const xApi = String(req.headers['x-api-key'] || '');

  if (auth && /^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const oauth = resolveOAuthAccessToken(token);
    if (oauth) return { clientId: oauth.clientId, credential: token, fingerprint: fingerprint(token) };
    if (ALLOW_LEGACY_API_KEY && MCP_API_KEY && timingSafeEqualText(token, MCP_API_KEY)) return { clientId: 'legacy', credential: MCP_API_KEY, fingerprint: fingerprint(MCP_API_KEY) };
  }

  if (ALLOW_LEGACY_API_KEY && xApi && MCP_API_KEY && timingSafeEqualText(xApi, MCP_API_KEY)) {
    return { clientId: 'legacy', credential: MCP_API_KEY, fingerprint: fingerprint(MCP_API_KEY) };
  }
  return null;
}

function validateClientCredentialHeaders(req: Request): void {
  if (!ALLOW_CLIENT_CREDENTIAL_HEADERS) {
    if (req.headers['x-github-token'] || req.headers['x-render-token']) throw new Error('Client-supplied provider credentials are disabled. Configure server-side credentials instead.');
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);
app.use((req, res, next) => { securityHeaders(res); res.setHeader('X-Request-ID', requestId(req)); next(); });
app.use((req, res, next) => { if (!validateOrigin(req, res)) return; next(); });
app.use(express.json({ limit: process.env.MCP_BODY_LIMIT || '5mb', strict: true, type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));
app.use('/assets', express.static(path.resolve('assets'), { dotfiles: 'deny', index: false, maxAge: '7d', immutable: false }));
app.get('/logo.svg', (_req, res) => { res.type('image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.sendFile(path.resolve('assets/logo.svg')); });
app.get('/favicon.svg', (_req, res) => res.redirect(302, '/logo.svg'));

app.get('/.well-known/oauth-authorization-server', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(oauthMetadata(req)); });
app.get('/.well-known/oauth-protected-resource', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(protectedResourceMetadata(req)); });
// Compatibility aliases used by MCP clients that scope discovery to the protected resource path.
app.get('/mcp/.well-known/oauth-authorization-server', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(oauthMetadata(req)); });
app.get('/mcp/.well-known/oauth-protected-resource', (req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(protectedResourceMetadata(req)); });
app.get('/oauth/authorize', oauthAuthorize);
app.post('/oauth/authorize', oauthAuthorizePost);
app.post('/oauth/token', oauthToken);
app.post('/oauth/register', oauthRegister);
app.post('/oauth/revoke', oauthRevoke);

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  const rid = res.getHeader('X-Request-ID');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, DELETE'); jsonRpcError(res, 405, 'Method not allowed.', req.body?.id); return; }
  const limit = consumeRateLimit(`mcp:${clientIp(req)}`, Number(process.env.MCP_RATE_LIMIT || 120), 60_000);
  if (!limit.allowed) { res.setHeader('Retry-After', String(limit.retryAfterSeconds)); jsonRpcError(res, 429, 'Rate limit exceeded.', req.body?.id); return; }
  if (!MCP_API_KEY) { console.error(`[${rid}] MCP_API_KEY missing`); jsonRpcError(res, 503, 'Service unavailable.', req.body?.id); return; }

  let auth: ReturnType<typeof parseAuthorization>;
  try { validateClientCredentialHeaders(req); auth = parseAuthorization(req); } catch (error: any) { jsonRpcError(res, 400, error?.message || 'Invalid credentials.', req.body?.id); return; }
  if (!auth) {
    const resourceMetadata = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/.well-known/oauth-protected-resource`;
    res.setHeader('WWW-Authenticate', `Bearer realm="krix", resource_metadata="${resourceMetadata}"`);
    jsonRpcError(res, 401, 'Unauthorized.', req.body?.id);
    return;
  }

  const githubToken = ALLOW_CLIENT_CREDENTIAL_HEADERS ? (String(req.headers['x-github-token'] || '') || DEFAULT_GITHUB_PAT) : DEFAULT_GITHUB_PAT;
  const renderToken = ALLOW_CLIENT_CREDENTIAL_HEADERS ? (String(req.headers['x-render-token'] || '') || DEFAULT_RENDER_API_KEY) : DEFAULT_RENDER_API_KEY;
  const sessionId = String(req.headers['mcp-session-id'] || '');

  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    if (entry.authFingerprint !== auth.fingerprint || entry.clientId !== auth.clientId) { jsonRpcError(res, 403, 'MCP session is bound to a different authorization.', req.body?.id); return; }
    entry.lastActive = Date.now();
    registerSessionAuth(sessionId, githubToken, auth.clientId);
    try { await entry.transport.handleRequest(req, res, req.body); }
    catch (error) { console.error(`[${rid}] MCP session error`, error); if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error.', req.body?.id); }
    return;
  }

  if (transports.size >= MAX_SESSIONS) { jsonRpcError(res, 503, 'Session capacity reached.'); return; }
  const newSessionId = crypto.randomUUID();
  registerSessionAuth(newSessionId, githubToken, auth.clientId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (id) => { transports.set(id, { transport, lastActive: Date.now(), authFingerprint: auth!.fingerprint, clientId: auth!.clientId }); }
  });
  transport.onclose = () => {
    if (transport.sessionId) { void destroySandbox(transport.sessionId); transports.delete(transport.sessionId); }
  };

  const masterServer = createMasterServer(githubToken, renderToken, newSessionId);
  try { await masterServer.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (error) { console.error(`[${rid}] MCP request error`, error); if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error.', req.body?.id); }
});

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', (_req, res) => {
  const ready = !!MCP_API_KEY && (!isProduction || process.env.PUBLIC_BASE_URL?.startsWith('https://'));
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});
app.get('/', (_req, res) => { res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Krix</title></head><body style="margin:0;background:#f4f4f2;color:#111;font-family:system-ui;display:grid;place-items:center;min-height:100vh"><main style="background:white;border:1px solid #ddd;border-radius:24px;padding:32px;box-shadow:0 20px 60px #0001"><img src="/logo.svg" width="56" height="56" alt="Krix"><h1>Krix Gateway</h1><p style="color:#666">Secure MCP gateway.</p></main></body></html>'); });

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = Number(process.env.MCP_SESSION_IDLE_MS || 10 * 60 * 1000);
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) { void destroySandbox(id); try { void entry.transport.close(); } catch {} transports.delete(id); }
  }
}, 60_000);
cleanupTimer.unref();

const server = app.listen(PORT, () => console.log(`Krix gateway listening on ${PORT}`));
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120_000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 15_000);
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65_000);

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  clearInterval(cleanupTimer);
  for (const [id, entry] of transports) { void destroySandbox(id); try { void entry.transport.close(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => { console.error('uncaughtException', error); if (isProduction) shutdown('uncaughtException'); });
process.on('unhandledRejection', (error) => { console.error('unhandledRejection', error); });

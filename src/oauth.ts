import crypto from 'node:crypto';
import type { Request, Response } from 'express';

const ISSUER = (process.env.OAUTH_ISSUER || '').replace(/\/$/, '');
const SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || '';
const RESOURCE = `${ISSUER}/mcp`;

const ACCESS_TTL_SECONDS = 60 * 60;           // 1 hour
const AUTH_CODE_TTL_SECONDS = 5 * 60;         // 5 minutes
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

type ClientMetadata = {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  redirect_uris: string[];
};

// Security: In-memory sliding window rate limiter & single-use auth code store
const usedAuthCodes = new Set<string>();
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count += 1;
  return true;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function requireConfig(): void {
  if (!ISSUER || !/^https:\/\//i.test(ISSUER)) {
    throw new Error('OAUTH_ISSUER must be the public HTTPS Krix URL.');
  }
  if (SIGNING_SECRET.length < 32) {
    throw new Error('OAUTH_SIGNING_SECRET must be at least 32 characters.');
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function unb64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function encodeSigned(payload: Record<string, unknown>): string {
  requireConfig();
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

function decodeSigned<T extends Record<string, any>>(value: string): T | null {
  try {
    requireConfig();
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;

    const body = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    const expected = hmac(body);
    if (!timingSafeEqualString(signature, expected)) return null;

    return JSON.parse(unb64url(body)) as T;
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function validExpiry(exp: unknown): exp is number {
  return typeof exp === 'number' && Number.isFinite(exp) && exp > nowSeconds();
}

function safeRedirectUri(uri: unknown): uri is string {
  // MCP clients may use HTTPS redirect URIs. Loopback HTTP is allowed for local clients.
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function clientIdFor(metadata: Omit<ClientMetadata, 'client_id'>): string {
  // Stateless client registration: the client ID contains signed metadata.
  const payload = {
    v: 1,
    name: metadata.client_name || '',
    logo: metadata.logo_uri || '',
    redirects: [...metadata.redirect_uris].sort()
  };
  return `https://${new URL(ISSUER).host}/oauth/client/${encodeSigned(payload)}`;
}

function parseClient(clientId: unknown): ClientMetadata | null {
  if (typeof clientId !== 'string' || clientId.length > 2048) return null;

  try {
    const prefix = `https://${new URL(ISSUER).host}/oauth/client/`;
    if (!clientId.startsWith(prefix)) return null;

    const payload = decodeSigned<Record<string, any>>(clientId.slice(prefix.length));
    if (!payload || payload.v !== 1 || !Array.isArray(payload.redirects)) return null;
    if (payload.redirects.length === 0 || payload.redirects.length > 20) return null;
    if (payload.redirects.some((uri: unknown) => !safeRedirectUri(uri))) return null;

    return {
      client_id: clientId,
      client_name: typeof payload.name === 'string' ? payload.name : undefined,
      logo_uri: typeof payload.logo === 'string' && /^https:\/\//i.test(payload.logo) ? payload.logo : undefined,
      redirect_uris: payload.redirects
    };
  } catch {
    return null;
  }
}

function resolveDynamicClientLogo(clientName?: string, redirectUris: string[] = [], explicitLogo?: string): string | undefined {
  if (explicitLogo && /^https:\/\//i.test(explicitLogo)) {
    return explicitLogo;
  }

  // 1. Try extracting origin domain from redirect URIs (for web/cloud client apps)
  for (const uri of redirectUris) {
    try {
      const url = new URL(uri);
      if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`;
      }
    } catch {}
  }

  // 2. Dynamic matching based on client name or domain
  if (clientName) {
    const nameLower = clientName.toLowerCase().trim();

    // Ecosystem brand matching
    if (nameLower.includes('gemini')) return 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a611345.svg';
    if (nameLower.includes('claude')) return 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/logo.png';
    if (nameLower.includes('cursor')) return 'https://www.cursor.com/favicon.ico';
    if (nameLower.includes('copilot') || nameLower.includes('github')) return 'https://github.githubassets.com/favicons/favicon.png';
    if (nameLower.includes('chatgpt') || nameLower.includes('openai')) return 'https://openai.com/favicon.ico';
    if (nameLower.includes('antigravity')) return 'https://antigravity.dev/favicon.ico';

    // If client name is or contains a domain (e.g., "my-app.com")
    const domainMatch = nameLower.match(/([a-z0-9-]+\.[a-z]{2,})/);
    if (domainMatch) {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainMatch[1])}&sz=128`;
    }

    // Dynamic fallback favicon fetch via brand name domain
    const cleanName = nameLower.replace(/[^a-z0-9]/g, '');
    if (cleanName) {
      return `https://www.google.com/s2/favicons?domain=${cleanName}.com&sz=128`;
    }
  }

  return undefined;
}

export function oauthResource(): string {
  return RESOURCE;
}

export function protectedResourceMetadataUrl(): string {
  return `${ISSUER}/.well-known/oauth-protected-resource`;
}

export function sendProtectedResourceMetadata(_req: Request, res: Response): void {
  try {
    requireConfig();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.json({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp']
    });
  } catch (error: any) {
    res.status(500).json({ error: 'server_configuration_error', error_description: 'Server misconfigured.' });
  }
}

export function sendAuthorizationServerMetadata(_req: Request, res: Response): void {
  try {
    requireConfig();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      // We deliberately use stateless DCR. Client metadata is carried in the signed client_id.
      client_id_metadata_document_supported: false
    });
  } catch (error: any) {
    res.status(500).json({ error: 'server_configuration_error', error_description: 'Server misconfigured.' });
  }
}

export function registerClient(req: Request, res: Response): void {
  try {
    requireConfig();

    if (!checkRateLimit(`register:${getClientIp(req)}`, 15, 60000)) {
      res.status(429).json({ error: 'slow_down', error_description: 'Rate limit exceeded for client registration.' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

    if (
      !redirectUris.length ||
      redirectUris.length > 20 ||
      redirectUris.some((uri: unknown) => !safeRedirectUri(uri))
    ) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris must contain valid HTTPS URLs or local loopback HTTP URLs.'
      });
      return;
    }

    const logoUri = typeof body.logo_uri === 'string' && /^https:\/\//i.test(body.logo_uri)
      ? body.logo_uri.slice(0, 1024)
      : (typeof body.client_logo === 'string' && /^https:\/\//i.test(body.client_logo) ? body.client_logo.slice(0, 1024) : undefined);

    const metadata = {
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined,
      logo_uri: logoUri,
      redirect_uris: [...new Set(redirectUris as string[])]
    };

    const clientId = clientIdFor(metadata);

    res.status(201).json({
      client_id: clientId,
      client_name: metadata.client_name,
      logo_uri: metadata.logo_uri,
      redirect_uris: metadata.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    });
  } catch (error: any) {
    res.status(500).json({ error: 'server_configuration_error', error_description: 'Server misconfigured.' });
  }
}

export function authorize(req: Request, res: Response): void {
  try {
    requireConfig();

    if (!checkRateLimit(`auth_get:${getClientIp(req)}`, 30, 60000)) {
      res.status(429).send('Rate limit exceeded. Please try again in a minute.');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    const {
      response_type,
      client_id,
      redirect_uri,
      scope = 'mcp',
      state,
      code_challenge,
      code_challenge_method = 'S256',
      resource = RESOURCE
    } = req.query;

    const client = parseClient(client_id);
    const redirect = typeof redirect_uri === 'string' ? redirect_uri : '';

    if (
      response_type !== 'code' ||
      !client ||
      !client.redirect_uris.includes(redirect) ||
      code_challenge_method !== 'S256' ||
      typeof code_challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge) ||
      resource !== RESOURCE ||
      (typeof scope === 'string' && scope !== 'mcp')
    ) {
      res.status(400).send('Invalid OAuth authorization request.');
      return;
    }

    // Dynamically resolve client logo (supports Gemini Spark, AntiGravity, Claude, Cursor, OpenAI, or custom redirect domains)
    const logoUrl = resolveDynamicClientLogo(client.client_name, client.redirect_uris, client.logo_uri);

    // Generate stateless signed anti-CSRF token
    const csrfToken = encodeSigned({
      typ: 'csrf',
      client_id: client.client_id,
      exp: nowSeconds() + 600,
      nonce: crypto.randomBytes(16).toString('base64url')
    });

    const hidden = (name: string, value: string) =>
      `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(client.client_name || 'MCP Client')} &ndash; Krix</title>
<style>
  :root {
    --bg: #f8fafc;
    --card-bg: #ffffff;
    --card-border: #e2e8f0;
    --text-main: #0f172a;
    --text-muted: #64748b;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-glow: rgba(79, 70, 229, 0.15);
    --input-bg: #f1f5f9;
    --input-border: #cbd5e1;
    --input-focus: #4f46e5;
    --badge-bg: #e0e7ff;
    --badge-text: #3730a3;
    --shield-bg: #ecfdf5;
    --shield-text: #065f46;
    --shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.25);
      --input-bg: #1e293b;
      --input-border: #334155;
      --input-focus: #6366f1;
      --badge-bg: #312e81;
      --badge-text: #e0e7ff;
      --shield-bg: #064e3b;
      --shield-text: #a7f3d0;
      --shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background-color: var(--bg);
    color: var(--text-main);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 24px;
    line-height: 1.5;
  }

  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulseGlow {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.12); }
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 20px;
    padding: 36px 32px;
    max-width: 440px;
    width: 100%;
    box-shadow: var(--shadow);
    animation: fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  .brand-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin-bottom: 28px;
  }

  .node-logo {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    object-fit: cover;
    border: 2px solid var(--card-border);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .client-avatar {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: var(--badge-bg);
    color: var(--badge-text);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 20px;
    border: 2px solid var(--card-border);
    overflow: hidden;
    position: relative;
  }

  .client-logo-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .client-initial {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .connection-line {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
  }

  .connection-line svg {
    animation: pulseGlow 2s infinite ease-in-out;
  }

  .title-group {
    text-align: center;
    margin-bottom: 24px;
  }

  .title-group h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 8px;
  }

  .title-group p {
    font-size: 14px;
    color: var(--text-muted);
  }

  .scope-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--shield-bg);
    color: var(--shield-text);
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    margin-top: 12px;
  }

  .form-group {
    margin-top: 24px;
  }

  .form-group label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .input-icon {
    position: absolute;
    left: 14px;
    color: var(--text-muted);
    pointer-events: none;
  }

  input[type="password"] {
    width: 100%;
    padding: 12px 14px 12px 42px;
    font-size: 15px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 12px;
    color: var(--text-main);
    outline: none;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  input[type="password"]:focus {
    border-color: var(--input-focus);
    box-shadow: 0 0 0 4px var(--accent-glow);
  }

  .btn-authorize {
    width: 100%;
    padding: 13px;
    margin-top: 20px;
    border: none;
    border-radius: 12px;
    background: var(--accent);
    color: #ffffff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: background-color 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
  }

  .btn-authorize:hover {
    background: var(--accent-hover);
    box-shadow: 0 4px 12px var(--accent-glow);
  }

  .btn-authorize:active {
    transform: scale(0.98);
  }

  .security-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 22px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  .security-footer svg {
    flex-shrink: 0;
  }
</style>
</head>
<body>
<div class="card">
  <div class="brand-header">
    <div class="client-avatar" title="${escapeHtml(client.client_name || 'Client')}">
      ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(client.client_name || 'Client')}" class="client-logo-img" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">` : ''}
      <div class="client-initial" ${logoUrl ? 'style="display:none;"' : ''}>
        ${escapeHtml((client.client_name || 'C').charAt(0).toUpperCase())}
      </div>
    </div>
    <div class="connection-line">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
    </div>
    <img src="/logo.jpg" alt="Krix Logo" class="node-logo" onerror="this.style.display='none'">
  </div>

  <div class="title-group">
    <h1>Authorize Krix Access</h1>
    <p><b>${escapeHtml(client.client_name || 'An MCP client')}</b> is requesting permission to execute Krix MCP tools on your behalf.</p>
    <div class="scope-badge">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <polyline points="9 12 11 14 15 10"/>
      </svg>
      MCP Server &amp; Tools Access
    </div>
  </div>

  <form method="post" action="/oauth/authorize">
    ${hidden('client_id', client.client_id)}
    ${hidden('redirect_uri', redirect)}
    ${hidden('scope', 'mcp')}
    ${hidden('state', typeof state === 'string' ? state : '')}
    ${hidden('code_challenge', code_challenge)}
    ${hidden('resource', RESOURCE)}
    ${hidden('_csrf', csrfToken)}

    <div class="form-group">
      <label for="approval_key">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="7.5" cy="15.5" r="5.5"/>
          <path d="m21 2-9.6 9.6"/>
          <path d="m15.5 7.5 3 3"/>
        </svg>
        Krix API Key
      </label>
      <div class="input-wrapper">
        <svg class="input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <input id="approval_key" type="password" name="approval_key" placeholder="Enter secret API key" autocomplete="current-password" required autofocus>
      </div>
    </div>

    <button type="submit" class="btn-authorize">
      Authorize Access
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="5" y1="12" x2="19" y2="12"/>
        <polyline points="12 5 19 12 12 19"/>
      </svg>
    </button>
  </form>

  <div class="security-footer">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
    Only authorize applications and clients you recognize.
  </div>
</div>
</body>
</html>`);
  } catch (error: any) {
    res.status(500).send('OAuth configuration error.');
  }
}

export function authorizePost(req: Request, res: Response): void {
  try {
    requireConfig();

    if (!checkRateLimit(`auth_post:${getClientIp(req)}`, 10, 60000)) {
      res.status(429).send('Rate limit exceeded. Too many authorization attempts.');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    const {
      client_id,
      redirect_uri,
      scope = 'mcp',
      state = '',
      code_challenge,
      resource = RESOURCE,
      approval_key,
      _csrf
    } = req.body || {};

    // Validate anti-CSRF token
    const csrfPayload = typeof _csrf === 'string' ? decodeSigned<Record<string, any>>(_csrf) : null;
    if (
      !csrfPayload ||
      csrfPayload.typ !== 'csrf' ||
      csrfPayload.client_id !== client_id ||
      !validExpiry(csrfPayload.exp)
    ) {
      res.status(400).send('CSRF validation failed or token expired.');
      return;
    }

    // Origin / Referer check for post requests
    const origin = req.headers['origin'] || req.headers['referer'];
    if (typeof origin === 'string' && /^https:\/\//i.test(origin)) {
      try {
        const originHost = new URL(origin).host;
        const issuerHost = new URL(ISSUER).host;
        if (originHost !== issuerHost) {
          res.status(400).send('Cross-origin form submission blocked.');
          return;
        }
      } catch {}
    }

    const client = parseClient(client_id);
    const configuredKey = process.env.MCP_API_KEY || '';

    if (
      !client ||
      !client.redirect_uris.includes(redirect_uri) ||
      resource !== RESOURCE ||
      scope !== 'mcp' ||
      typeof code_challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge) ||
      !configuredKey ||
      !timingSafeEqualString(String(approval_key || ''), configuredKey)
    ) {
      res.status(400).send('Authorization denied.');
      return;
    }

    // The authorization code is signed and self-contained.
    const code = encodeSigned({
      typ: 'authorization_code',
      client_id,
      redirect_uri,
      code_challenge,
      resource: RESOURCE,
      scope: 'mcp',
      iat: nowSeconds(),
      exp: nowSeconds() + AUTH_CODE_TTL_SECONDS,
      nonce: crypto.randomBytes(16).toString('base64url')
    });

    const target = new URL(redirect_uri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    res.redirect(target.toString());
  } catch (error: any) {
    res.status(500).send('OAuth configuration error.');
  }
}

export function token(req: Request, res: Response): void {
  try {
    requireConfig();

    if (!checkRateLimit(`token:${getClientIp(req)}`, 30, 60000)) {
      res.status(429).json({ error: 'slow_down', error_description: 'Rate limit exceeded for token endpoint.' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    const grantType = req.body?.grant_type;
    if (grantType === 'authorization_code') {
      issueFromCode(req, res);
      return;
    }
    if (grantType === 'refresh_token') {
      issueFromRefresh(req, res);
      return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (error: any) {
    res.status(500).json({ error: 'server_configuration_error', error_description: 'Server error.' });
  }
}

function issueFromCode(req: Request, res: Response): void {
  const { code, client_id, redirect_uri, code_verifier, resource = RESOURCE } = req.body || {};
  const payload = typeof code === 'string'
    ? decodeSigned<Record<string, any>>(code)
    : null;

  const client = parseClient(client_id);

  if (
    !payload ||
    payload.typ !== 'authorization_code' ||
    !validExpiry(payload.exp) ||
    !client ||
    payload.client_id !== client_id ||
    payload.redirect_uri !== redirect_uri ||
    payload.resource !== resource ||
    payload.scope !== 'mcp' ||
    typeof code_verifier !== 'string' ||
    code_verifier.length < 43 ||
    code_verifier.length > 128
  ) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  // Single-use enforcement: authorization code replay prevention
  if (typeof payload.nonce === 'string' && usedAuthCodes.has(payload.nonce)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code already redeemed.' });
    return;
  }
  if (typeof payload.nonce === 'string') {
    usedAuthCodes.add(payload.nonce);
    if (usedAuthCodes.size > 10000) {
      usedAuthCodes.clear();
    }
  }

  const expectedChallenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
  if (!timingSafeEqualString(expectedChallenge, payload.code_challenge)) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  issueTokens(res, client_id, payload.scope, payload.resource);
}

function issueFromRefresh(req: Request, res: Response): void {
  const supplied = String(req.body?.refresh_token || '');
  const payload = decodeSigned<Record<string, any>>(supplied);

  if (
    !payload ||
    payload.typ !== 'refresh_token' ||
    !validExpiry(payload.exp) ||
    typeof payload.client_id !== 'string' ||
    payload.resource !== RESOURCE ||
    payload.scope !== 'mcp'
  ) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  const client = parseClient(req.body?.client_id);
  if (!client || client.client_id !== payload.client_id) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  issueTokens(res, payload.client_id, payload.scope, payload.resource);
}

function issueTokens(res: Response, clientId: string, scope: string, resource: string): void {
  const now = nowSeconds();

  const accessToken = encodeSigned({
    typ: 'access_token',
    iss: ISSUER,
    aud: resource,
    sub: clientId,
    scope,
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
    jti: crypto.randomBytes(16).toString('base64url')
  });

  const refreshToken = encodeSigned({
    typ: 'refresh_token',
    iss: ISSUER,
    aud: resource,
    client_id: clientId,
    scope,
    iat: now,
    exp: now + REFRESH_TTL_SECONDS,
    jti: crypto.randomBytes(32).toString('base64url')
  });

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope
  });
}

export function verifyAccessToken(tokenValue: string): boolean {
  if (typeof tokenValue !== 'string' || tokenValue.length > 4096) return false;
  const payload = decodeSigned<Record<string, any>>(tokenValue);
  return !!payload &&
    payload.typ === 'access_token' &&
    payload.iss === ISSUER &&
    payload.aud === RESOURCE &&
    typeof payload.sub === 'string' &&
    payload.scope === 'mcp' &&
    validExpiry(payload.exp);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c] || c));
}

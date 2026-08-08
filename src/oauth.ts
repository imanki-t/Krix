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
      redirect_uris: payload.redirects
    };
  } catch {
    return null;
  }
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

    const metadata = {
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined,
      redirect_uris: [...new Set(redirectUris as string[])]
    };

    const clientId = clientIdFor(metadata);

    res.status(201).json({
      client_id: clientId,
      client_name: metadata.client_name,
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
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Krix Authorization</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:24px;line-height:1.5}
.card{border:1px solid #ddd;border-radius:14px;padding:24px}
button{padding:11px 18px;border:0;border-radius:9px;background:#111;color:#fff;font-size:16px;cursor:pointer}
input{width:100%;padding:11px;margin:8px 0 18px;box-sizing:border-box;border:1px solid #bbb;border-radius:8px}
small{color:#666}
</style></head><body><div class="card">
<h1>Authorize Krix</h1>
<p><b>${escapeHtml(client.client_name || 'An MCP client')}</b> is requesting access to your Krix MCP tools.</p>
<p><small>Only authorize clients you recognize.</small></p>
<form method="post" action="/oauth/authorize">
${hidden('client_id', client.client_id)}
${hidden('redirect_uri', redirect)}
${hidden('scope', 'mcp')}
${hidden('state', typeof state === 'string' ? state : '')}
${hidden('code_challenge', code_challenge)}
${hidden('resource', RESOURCE)}
${hidden('_csrf', csrfToken)}
<label for="approval_key">Krix API key</label>
<input id="approval_key" type="password" name="approval_key" autocomplete="current-password" required>
<button type="submit">Authorize</button>
</form></div></body></html>`);
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

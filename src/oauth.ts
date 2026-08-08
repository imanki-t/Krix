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
  if (typeof uri !== 'string') return false;
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
  if (typeof clientId !== 'string') return null;

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
    res.json({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp']
    });
  } catch (error: any) {
    res.status(500).json({ error: 'server_configuration_error', error_description: error.message });
  }
}

export function sendAuthorizationServerMetadata(_req: Request, res: Response): void {
  try {
    requireConfig();
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
    res.status(500).json({ error: 'server_configuration_error', error_description: error.message });
  }
}

export function registerClient(req: Request, res: Response): void {
  try {
    requireConfig();

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
    res.status(500).json({ error: 'server_configuration_error', error_description: error.message });
  }
}

export function authorize(req: Request, res: Response): void {
  try {
    requireConfig();

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

    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

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
<label for="approval_key">Krix API key</label>
<input id="approval_key" type="password" name="approval_key" autocomplete="current-password" required>
<button type="submit">Authorize</button>
</form></div></body></html>`);
  } catch (error: any) {
    res.status(500).send(`OAuth configuration error: ${escapeHtml(error.message)}`);
  }
}

export function authorizePost(req: Request, res: Response): void {
  try {
    requireConfig();

    const {
      client_id,
      redirect_uri,
      scope = 'mcp',
      state = '',
      code_challenge,
      resource = RESOURCE,
      approval_key
    } = req.body || {};

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

    // The authorization code is signed and self-contained, so it survives restarts.
    // PKCE prevents an intercepted code from being redeemed without the verifier.
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
    res.status(500).send(`OAuth configuration error: ${escapeHtml(error.message)}`);
  }
}

export function token(req: Request, res: Response): void {
  try {
    requireConfig();

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
    res.status(500).json({ error: 'server_configuration_error', error_description: error.message });
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
    typeof code_verifier !== 'string'
  ) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
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

  // Stateless refresh token. It is a bearer credential and therefore should
  // be treated like a secret. Rotation is represented by issuing a new token
  // on every refresh; server-side revocation would require persistent storage.
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

  res.set('Cache-Control', 'no-store');
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

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { consumeRateLimit, timingSafeEqualText } from './security.js';

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt: number;
}

interface AuthorizationRequest {
  requestId: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

interface AccessTokenRecord {
  tokenHash: string;
  clientId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

const clients = new Map<string, RegisteredClient>();
const authorizationRequests = new Map<string, AuthorizationRequest>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessTokenRecord>();

const AUTH_REQUEST_TTL_MS = 5 * 60 * 1000;
const AUTH_CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_CLIENTS = 500;
const MAX_TOKENS = 1000;
const SUPPORTED_SCOPE = 'mcp';

function configuredBaseUrl(): string | undefined {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Invalid PUBLIC_BASE_URL.');
  }
}

function baseUrl(req: Request): string {
  const configured = configuredBaseUrl();
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000').split(',')[0].trim();
  if (process.env.NODE_ENV === 'production' && proto !== 'https') throw new Error('Refusing to construct production OAuth URLs without HTTPS. Set PUBLIC_BASE_URL.');
  return `${proto}://${host}`;
}

function randomToken(bytes = 32): string { return crypto.randomBytes(bytes).toString('base64url'); }
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

function htmlEscape(value: string): string {
  return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!));
}

function validClientId(value: string): boolean { return /^[A-Za-z0-9._~-]{8,128}$/.test(value); }

function validRedirectUri(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u001F\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  } catch { return false; }
}

function validPkceChallenge(value: string): boolean { return /^[A-Za-z0-9._~-]{43,128}$/.test(value); }

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return timingSafeEqualText(digest, challenge);
}

function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sameOriginLogo(req: Request): string {
  const configured = process.env.APP_LOGO_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.origin === baseUrl(req)) return url.toString();
    } catch {}
  }
  return `${baseUrl(req)}/logo.png`;
}

function reject(res: Response, status: number, message: string): void {
  setNoStore(res);
  res.status(status).json({ error: message });
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function checkLimit(req: Request, res: Response, bucket: string, limit: number, windowMs: number, blockMs = 0): boolean {
  const result = consumeRateLimit(`${bucket}:${clientIp(req)}`, limit, windowMs, blockMs);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retry_after_seconds: result.retryAfterSeconds });
    return false;
  }
  return true;
}

export function oauthAuthorize(req: Request, res: Response): void {
  if (!checkLimit(req, res, 'oauth-authorize', 30, 60_000)) return;
  try {
    const clientId = String(req.query.client_id || '');
    const redirectUri = String(req.query.redirect_uri || '');
    const responseType = String(req.query.response_type || '');
    const challenge = String(req.query.code_challenge || '');
    const method = String(req.query.code_challenge_method || '');
    const state = req.query.state === undefined ? undefined : String(req.query.state);
    const scope = String(req.query.scope || SUPPORTED_SCOPE);

    const client = clients.get(clientId);
    if (responseType !== 'code' || !validClientId(clientId) || !client || !validRedirectUri(redirectUri) ||
        !client.redirectUris.includes(redirectUri) || method !== 'S256' || !validPkceChallenge(challenge) || scope !== SUPPORTED_SCOPE ||
        (state !== undefined && state.length > 2048)) {
      res.status(400).type('text/plain').send('Invalid OAuth authorization request.');
      return;
    }

    client.lastUsedAt = Date.now();
    const requestId = randomToken(24);
    authorizationRequests.set(requestId, {
      requestId, clientId, redirectUri, state, codeChallenge: challenge, scope,
      createdAt: Date.now(), expiresAt: Date.now() + AUTH_REQUEST_TTL_MS
    });

    const appName = process.env.APP_NAME || 'Krix';
    const logoUrl = sameOriginLogo(req);
    const nonce = randomToken(18);
    setNoStore(res);
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self'`);
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Authorize ${htmlEscape(appName)}</title><link rel="icon" href="${htmlEscape(logoUrl)}" type="image/svg+xml"><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;background:#f3f3f1}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.wrap{width:min(470px,100%)}.card{background:#fff;border:1px solid #dededb;border-radius:28px;padding:32px;box-shadow:0 24px 80px rgba(0,0,0,.09)}.brand{display:flex;align-items:center;gap:13px}.logo{width:48px;height:48px;border-radius:15px;border:1px solid #dededb;object-fit:cover;background:#111}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.14em;font-weight:800;color:#777}.name{font-weight:800;margin-top:4px}.client{margin-top:24px;display:inline-flex;padding:8px 11px;border-radius:999px;background:#f1f1ef;font-size:13px;font-weight:700}.title{font-size:32px;letter-spacing:-.045em;line-height:1.05;margin:18px 0 10px}.copy{color:#666;line-height:1.6;margin:0 0 24px}.field{font-size:13px;font-weight:750;display:block;margin-bottom:8px}.input{width:100%;height:52px;border:1px solid #d5d5d2;border-radius:14px;padding:0 15px;font:inherit;outline:0;background:#fff}.input:focus{border-color:#111;box-shadow:0 0 0 4px rgba(0,0,0,.07)}.button{width:100%;height:52px;border:0;border-radius:14px;background:#111;color:#fff;font:inherit;font-weight:800;margin-top:14px;cursor:pointer}.button:disabled{opacity:.55;cursor:wait}.status{min-height:20px;color:#b42318;font-size:13px;margin-top:12px}.meta{margin-top:18px;text-align:center;color:#8a8a86;font-size:12px}.footer{text-align:center;color:#999;font-size:12px;margin-top:15px}</style></head><body><main class="wrap"><section class="card"><div class="brand"><img class="logo" id="logo" src="${htmlEscape(logoUrl)}" alt="${htmlEscape(appName)} logo"><div><div class="eyebrow">Secure MCP connection</div><div class="name">${htmlEscape(appName)}</div></div></div><div class="client">Connecting: ${htmlEscape(client.clientName)}</div><h1 class="title">Authorize access</h1><p class="copy">Enter your Krix access key to authorize this connector. The key is verified server-side and is never returned to the client.</p><label class="field" for="access-key">Access key</label><input class="input" id="access-key" type="password" autocomplete="current-password" spellcheck="false" autofocus><button class="button" id="authorize">Authorize connection</button><div class="status" id="status" role="alert" aria-live="polite"></div><div class="meta">OAuth 2.1 · PKCE S256 · one-time code</div></section><div class="footer">${htmlEscape(appName)} MCP Gateway</div></main><script nonce="${nonce}">
(()=>{const b=document.getElementById('authorize'),i=document.getElementById('access-key'),s=document.getElementById('status');const requestId=${JSON.stringify(requestId)};b.addEventListener('click',async()=>{s.textContent='';if(!i.value){s.textContent='Enter your access key.';return}b.disabled=true;b.textContent='Authorizing…';try{const r=await fetch('/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({request_id:requestId,access_key:i.value})});const j=await r.json().catch(()=>({}));if(r.redirected){location.assign(r.url);return}if(r.status>=300&&r.status<400&&r.headers.get('location')){location.assign(r.headers.get('location'));return}if(!r.ok)throw new Error(j.error||'Authorization failed.');location.assign(j.redirect_uri)}catch(e){s.textContent=e instanceof Error?e.message:'Authorization failed.';b.disabled=false;b.textContent='Authorize connection';}});i.addEventListener('keydown',e=>{if(e.key==='Enter')b.click()});const img=document.getElementById('logo');img.addEventListener('error',()=>{img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#111"/><path d="M22 22h18l9 18 9-18h18L58 48l18 26H58l-9-18-9 18H22l18-26Z" fill="#fff"/></svg>')},{once:true})})();</script></body></html>`);
  } catch {
    res.status(500).type('text/plain').send('OAuth configuration error.');
  }
}

export async function oauthAuthorizePost(req: Request, res: Response): Promise<void> {
  if (!checkLimit(req, res, 'oauth-authorize-post', 8, 60_000, 5 * 60_000)) return;
  const requestId = String(req.body?.request_id || '');
  const accessKey = String(req.body?.access_key || '');
  const record = authorizationRequests.get(requestId);
  if (!record || record.expiresAt <= Date.now()) { authorizationRequests.delete(requestId); reject(res, 400, 'authorization_request_expired'); return; }
  authorizationRequests.delete(requestId);

  const expected = process.env.MCP_API_KEY || '';
  if (!expected || !timingSafeEqualText(accessKey, expected)) { reject(res, 401, 'invalid_access_key'); return; }

  const code = randomToken(32);
  authorizationCodes.set(hash(code), {
    codeHash: hash(code), clientId: record.clientId, redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge, scope: record.scope, createdAt: Date.now(), expiresAt: Date.now() + AUTH_CODE_TTL_MS
  });
  const redirect = new URL(record.redirectUri);
  redirect.searchParams.set('code', code);
  if (record.state) redirect.searchParams.set('state', record.state);
  setNoStore(res);
  res.status(200).json({ redirect_uri: redirect.toString() });
}

export function oauthToken(req: Request, res: Response): void {
  if (!checkLimit(req, res, 'oauth-token', 30, 60_000)) return;
  const grantType = String(req.body?.grant_type || '');
  const code = String(req.body?.code || '');
  const clientId = String(req.body?.client_id || '');
  const redirectUri = String(req.body?.redirect_uri || '');
  const verifier = String(req.body?.code_verifier || '');
  if (grantType !== 'authorization_code' || !code || !validClientId(clientId) || !validRedirectUri(redirectUri) || !verifier) { reject(res, 400, 'invalid_request'); return; }
  const codeHash = hash(code);
  const record = authorizationCodes.get(codeHash);
  if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri || !verifyPkce(verifier, record.codeChallenge)) { authorizationCodes.delete(codeHash); reject(res, 400, 'invalid_grant'); return; }
  authorizationCodes.delete(codeHash);
  if (accessTokens.size >= MAX_TOKENS) { reject(res, 503, 'token_capacity_reached'); return; }
  const token = randomToken(48);
  const now = Date.now();
  accessTokens.set(hash(token), { tokenHash: hash(token), clientId, scope: record.scope, createdAt: now, expiresAt: now + ACCESS_TOKEN_TTL_MS, lastUsedAt: now });
  setNoStore(res);
  res.json({ access_token: token, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: record.scope });
}

export function oauthRegister(req: Request, res: Response): void {
  if (!checkLimit(req, res, 'oauth-register', 10, 60_000)) return;
  if (clients.size >= MAX_CLIENTS) { reject(res, 503, 'client_capacity_reached'); return; }
  const name = String(req.body?.client_name || 'MCP client').slice(0, 120);
  const redirectUris: string[] = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map((value: unknown) => String(value)) : [];
  if (!redirectUris.length || redirectUris.length > 20 || redirectUris.some((u: string) => !validRedirectUri(u))) { reject(res, 400, 'invalid_redirect_uris'); return; }
  const uniqueUris = [...new Set(redirectUris)];
  const clientId = randomToken(24);
  const now = Date.now();
  clients.set(clientId, { clientId, clientName: name || 'MCP client', redirectUris: uniqueUris, createdAt: now, lastUsedAt: now });
  setNoStore(res);
  res.status(201).json({ client_id: clientId, client_name: name || 'MCP client', redirect_uris: uniqueUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], code_challenge_methods_supported: ['S256'] });
}

export function oauthRevoke(req: Request, res: Response): void {
  if (!checkLimit(req, res, 'oauth-revoke', 30, 60_000)) return;
  const token = String(req.body?.token || '');
  if (token) accessTokens.delete(hash(token));
  setNoStore(res);
  res.status(200).send('');
}

export function resolveOAuthAccessToken(token: string): { clientId: string; scope: string } | undefined {
  if (!token || token.length < 32 || token.length > 128) return undefined;
  const key = hash(token);
  const record = accessTokens.get(key);
  if (!record || record.expiresAt <= Date.now()) { accessTokens.delete(key); return undefined; }
  record.lastUsedAt = Date.now();
  return { clientId: record.clientId, scope: record.scope };
}

export function oauthMetadata(req: Request) {
  const base = baseUrl(req);
  return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [SUPPORTED_SCOPE], logo_uri: sameOriginLogo(req) };
}

export function protectedResourceMetadata(req: Request) {
  const base = baseUrl(req);
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SUPPORTED_SCOPE] };
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, r] of authorizationRequests) if (r.expiresAt <= now) authorizationRequests.delete(id);
  for (const [id, r] of authorizationCodes) if (r.expiresAt <= now) authorizationCodes.delete(id);
  for (const [id, r] of accessTokens) if (r.expiresAt <= now) accessTokens.delete(id);
  for (const [id, r] of clients) if (now - r.lastUsedAt > 7 * 24 * 60 * 60 * 1000) clients.delete(id);
}, 60_000);
cleanup.unref();

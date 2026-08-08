import crypto from 'node:crypto';
import type { Request, Response } from 'express';

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope?: string;
  createdAt: number;
}

interface AuthorizationCode extends AuthorizationRequest {
  code: string;
  apiKey: string;
  used: boolean;
}

interface AccessToken {
  apiKey: string;
  clientId: string;
  scope?: string;
  expiresAt: number;
}

const authorizationRequests = new Map<string, AuthorizationRequest>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, { clientName?: string; redirectUris: string[] }>();

const AUTH_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

function baseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0].trim();
  return `${forwardedProto}://${host}`;
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]!);
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(challenge));
}

export function oauthAuthorize(req: Request, res: Response): void {
  const q = req.query;
  const clientId = String(q.client_id || '');
  const redirectUri = String(q.redirect_uri || '');
  const responseType = String(q.response_type || '');
  const codeChallenge = String(q.code_challenge || '');
  const method = String(q.code_challenge_method || '');

  if (responseType !== 'code' || !clientId || !redirectUri || !codeChallenge || method !== 'S256' || !validRedirectUri(redirectUri)) {
    res.status(400).type('text/plain').send('Invalid OAuth authorization request. PKCE (S256) is required.');
    return;
  }

  const registered = registeredClients.get(clientId);
  const allowedUris = registered?.redirectUris || [];
  if (allowedUris.length > 0 && !allowedUris.includes(redirectUri)) {
    res.status(400).type('text/plain').send('redirect_uri is not registered for this client.');
    return;
  }

  const requestId = randomToken(18);
  authorizationRequests.set(requestId, {
    clientId,
    redirectUri,
    state: q.state ? String(q.state) : undefined,
    codeChallenge,
    codeChallengeMethod: 'S256',
    scope: q.scope ? String(q.scope) : undefined,
    createdAt: Date.now()
  });

  const appName = process.env.APP_NAME || 'Krix';
  const logoUrl = process.env.APP_LOGO_URL || `${baseUrl(req)}/logo.svg`;
  const clientName = registered?.clientName || String(q.client_name || 'MCP client');

  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${htmlEscape(appName)}</title>
<link rel="icon" href="${htmlEscape(logoUrl)}" type="image/svg+xml">
<style>
:root{color-scheme:light;--ink:#111113;--muted:#73737a;--line:#e7e7e9;--surface:#fff;--soft:#f5f5f6;--accent:#111113;}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f4f4f3;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}.shell{width:min(460px,100%)}.card{background:rgba(255,255,255,.96);border:1px solid var(--line);border-radius:28px;padding:32px;box-shadow:0 24px 70px rgba(0,0,0,.08)}.brand{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo{width:48px;height:48px;border-radius:15px;border:1px solid var(--line);object-fit:cover;background:#111}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700}.title{font-size:30px;line-height:1.08;letter-spacing:-.04em;margin:7px 0 10px}.copy{color:var(--muted);line-height:1.6;margin:0 0 26px}.client{display:inline-flex;align-items:center;background:var(--soft);border-radius:999px;padding:8px 12px;font-size:13px;font-weight:650;margin-bottom:22px}.field{display:block;font-size:13px;font-weight:700;margin:0 0 8px}.input{width:100%;height:50px;border:1px solid #d9d9dc;border-radius:14px;background:#fff;padding:0 15px;font:inherit;outline:none}.input:focus{border-color:#888;box-shadow:0 0 0 4px #1111110b}.button{width:100%;height:50px;margin-top:16px;border:0;border-radius:14px;background:#111113;color:#fff;font:inherit;font-weight:750;cursor:pointer}.button:hover{background:#2a2a2d}.hint{font-size:12px;color:var(--muted);margin-top:16px;text-align:center}.footer{margin-top:16px;text-align:center;color:#999;font-size:12px}
</style></head><body><main class="shell"><section class="card">
<div class="brand"><img class="logo" id="logo" src="${htmlEscape(logoUrl)}" alt="${htmlEscape(appName)} logo"><div><div class="eyebrow">Secure connection</div><strong>${htmlEscape(appName)}</strong></div></div>
<div class="client">Connecting from ${htmlEscape(clientName)}</div>
<h1 class="title">Authorize access</h1>
<p class="copy">Enter your Krix access key to authorize this MCP connection. Your key is used only to establish the connection and is never shown to the client.</p>
<form id="authorize-form">
<input type="hidden" id="request_id" value="${htmlEscape(requestId)}">
<label class="field" for="access_key">Access key</label>
<input class="input" id="access_key" type="password" autocomplete="current-password" required autofocus placeholder="Enter your Krix access key">
<button class="button" type="submit">Authorize connection</button>
</form>
<div class="hint">OAuth 2.1 · PKCE · one-time authorization code</div>
</section><div class="footer">${htmlEscape(appName)} MCP Gateway</div></main>
<script>
(function(){const form=document.getElementById('authorize-form'); form?.addEventListener('submit',async function(event){event.preventDefault(); const key=document.getElementById('access_key').value; const requestId=document.getElementById('request_id').value; const button=form.querySelector('button'); button.disabled=true; button.textContent='Authorizing…'; try { const body=new URLSearchParams({request_id:requestId,access_key:key}); const response=await fetch('/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}); if(response.redirected){window.location.assign(response.url);return;} if(!response.ok) throw new Error(await response.text()); window.location.assign(response.url); } catch(error){ button.disabled=false; button.textContent='Authorize connection'; alert('Authorization failed. Please check your access key and try again.'); } }); const img=document.getElementById('logo'); if(!img)return; img.addEventListener('error',function(){img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#111"/><path d="M24 48 40 24h16L40 48l16 24H40L24 48Zm28 0 16-24h4l-16 24 16 24h-4L52 48Z" fill="white"/></svg>');},{once:true});})();
</script></body></html>`);
}

export function oauthAuthorizePost(req: Request, res: Response): void {
  const requestId = String(req.body?.request_id || '');
  const accessKey = String(req.body?.access_key || '');
  const auth = authorizationRequests.get(requestId);

  if (!auth || Date.now() - auth.createdAt > AUTH_TTL_MS) {
    res.status(400).type('text/plain').send('Authorization request expired. Please restart the connection.');
    return;
  }
  authorizationRequests.delete(requestId);

  if (!process.env.MCP_API_KEY || accessKey !== process.env.MCP_API_KEY) {
    res.status(401).type('text/html').send('<!doctype html><html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh"><div><h2>Authorization failed</h2><p>The access key is invalid.</p><p><a href="javascript:history.back()">Go back</a></p></div></body></html>');
    return;
  }

  const code = randomToken(32);
  authorizationCodes.set(code, { ...auth, code, apiKey: accessKey, used: false });
  const redirect = new URL(auth.redirectUri);
  redirect.searchParams.set('code', code);
  if (auth.state) redirect.searchParams.set('state', auth.state);
  res.redirect(302, redirect.toString());
}

export function oauthToken(req: Request, res: Response): void {
  const grantType = String(req.body?.grant_type || '');
  const code = String(req.body?.code || '');
  const clientId = String(req.body?.client_id || '');
  const redirectUri = String(req.body?.redirect_uri || '');
  const verifier = String(req.body?.code_verifier || '');

  if (grantType !== 'authorization_code' || !code || !clientId || !redirectUri || !verifier) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const record = authorizationCodes.get(code);
  if (!record || record.used || Date.now() - record.createdAt > AUTH_TTL_MS || record.clientId !== clientId || record.redirectUri !== redirectUri) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  if (!verifyPkce(verifier, record.codeChallenge)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    return;
  }

  record.used = true;
  authorizationCodes.delete(code);
  const accessToken = randomToken(32);
  const expiresIn = Math.floor(TOKEN_TTL_MS / 1000);
  accessTokens.set(accessToken, { apiKey: record.apiKey, clientId, scope: record.scope, expiresAt: Date.now() + TOKEN_TTL_MS });

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: record.scope || 'mcp' });
}

export function oauthRegister(req: Request, res: Response): void {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
  if (!redirectUris.length || redirectUris.some((uri: string) => !validRedirectUri(uri))) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }
  const clientId = `krix_${randomToken(18)}`;
  registeredClients.set(clientId, { clientName: req.body?.client_name ? String(req.body.client_name) : undefined, redirectUris });
  res.status(201).json({ client_id: clientId, client_name: req.body?.client_name || 'MCP client', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
}

export function resolveOAuthAccessToken(token: string): string | undefined {
  const record = accessTokens.get(token);
  if (!record) return undefined;
  if (Date.now() >= record.expiresAt) {
    accessTokens.delete(token);
    return undefined;
  }
  return record.apiKey;
}

export function oauthMetadata(req: Request) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    logo_uri: process.env.APP_LOGO_URL || `${base}/logo.svg`
  };
}

export function protectedResourceMetadata(req: Request) {
  const base = baseUrl(req);
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] };
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of authorizationRequests) if (now - value.createdAt > AUTH_TTL_MS) authorizationRequests.delete(key);
  for (const [key, value] of authorizationCodes) if (now - value.createdAt > AUTH_TTL_MS || value.used) authorizationCodes.delete(key);
  for (const [key, value] of accessTokens) if (now >= value.expiresAt) accessTokens.delete(key);
}, 60_000);
cleanup.unref();

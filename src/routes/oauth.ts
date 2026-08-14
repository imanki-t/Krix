import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../models/User.js';
import { generateRawApiKey } from '../services/cryptoService.js';
import { loadSettings } from '../config/settings.js';

export const oauthRouter = Router();

import rateLimit from 'express-rate-limit';

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many OAuth requests. Please try again later.' }
});
oauthRouter.use(oauthLimiter);

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const JWT_SECRET: jwt.Secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('[FATAL] JWT_SECRET required for OAuth in production'); })() : 'krix-dev-jwt-secret-fallback-key-2026');

interface DynamicClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthCodeEntry {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: number;
}

interface RefreshTokenFamily {
  familyId: string;
  userId: string;
  clientId: string;
  scope: string;
  activeToken: string;
  usedTokens: Set<string>;
  expiresAt: number;
}

const registeredClients = new Map<string, DynamicClient>();
const authCodes = new Map<string, AuthCodeEntry>();
const refreshFamilies = new Map<string, RefreshTokenFamily>();

// Cleanup expired auth codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes.entries()) {
    if (now > entry.expiresAt) authCodes.delete(code);
  }
  for (const [id, fam] of refreshFamilies.entries()) {
    if (now > fam.expiresAt) refreshFamilies.delete(id);
  }
  // Limit total entries to prevent memory exhaustion
  if (authCodes.size > 10000) authCodes.clear();
  if (refreshFamilies.size > 50000) refreshFamilies.clear();
}, 5 * 60 * 1000).unref();

const DEFAULT_ALLOWED_REDIRECTS = [
  'http://localhost:3000/oauth/callback',
  'http://127.0.0.1:3000/oauth/callback',
  'claude://oauth/callback',
  'vscode://cursor/oauth/callback'
];

function isRedirectAllowed(clientId: string | undefined, redirectUri: string): boolean {
  if (!redirectUri) return false;
  try {
    const parsed = new URL(redirectUri);
    if (!['http:', 'https:', 'claude:', 'vscode:'].includes(parsed.protocol)) {
      return false;
    }
  } catch {
    if (!redirectUri.startsWith('claude://') && !redirectUri.startsWith('vscode://')) {
      return false;
    }
  }

  if (clientId && registeredClients.has(clientId)) {
    return registeredClients.get(clientId)!.redirectUris.includes(redirectUri);
  }

  return DEFAULT_ALLOWED_REDIRECTS.includes(redirectUri);
}

registeredClients.set('claude_desktop', {
  clientId: 'claude_desktop',
  clientName: 'Claude Desktop App',
  redirectUris: ['http://localhost:3000/oauth/callback', 'http://127.0.0.1:3000/oauth/callback', 'claude://oauth/callback'],
  createdAt: Date.now()
});

registeredClients.set('cursor_ide', {
  clientId: 'cursor_ide',
  clientName: 'Cursor IDE',
  redirectUris: ['http://localhost:3000/oauth/callback', 'vscode://cursor/oauth/callback'],
  createdAt: Date.now()
});

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') {
    return false;
  }
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
    return hash === challenge;
  }
  return false;
}

oauthRouter.post('/register', (req: Request, res: Response): void => {
  try {
    const { client_name, redirect_uris } = req.body;
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris array is required.' });
      return;
    }

    // Limit registered dynamic clients
    if (registeredClients.size > 5000) {
      const firstKey = registeredClients.keys().next().value;
      if (firstKey && firstKey !== 'claude_desktop' && firstKey !== 'cursor_ide') {
        registeredClients.delete(firstKey);
      }
    }

    const clientId = `krix_client_${crypto.randomBytes(16).toString('hex')}`;
    const clientSecret = `krix_secret_${crypto.randomBytes(32).toString('hex')}`;
    const client: DynamicClient = {
      clientId,
      clientSecret,
      clientName: client_name ? escapeHtml(client_name) : 'Dynamic MCP Client',
      redirectUris: redirect_uris.filter(u => typeof u === 'string' && isRedirectAllowed(undefined, u)),
      createdAt: Date.now()
    };

    if (client.redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Valid http/https/claude/vscode redirect_uris required.' });
      return;
    }

    registeredClients.set(clientId, client);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

oauthRouter.get('/authorize', async (req: Request, res: Response): Promise<void> => {
  const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;

  if (response_type !== 'code') {
    res.status(400).send('Invalid response_type. Must be "code".');
    return;
  }

  const client = registeredClients.get(client_id);
  if (!client) {
    res.status(400).send('Unknown or unregistered client_id.');
    return;
  }
  if (!redirect_uri || !isRedirectAllowed(client_id, redirect_uri)) {
    res.status(400).send('Invalid or unauthorized redirect_uri.');
    return;
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    res.status(400).send('PKCE S256 code_challenge and code_challenge_method=S256 are required.');
    return;
  }

  const token = req.cookies?.krix_access_token;
  let user: any = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      user = await UserRepository.findById(payload.userId);
    } catch {}
  }

  if (!user) {
    const returnUrl = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?return_to=${returnUrl}`);
    return;
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Authorize AI Client - Krix</title>
      <link rel="icon" type="image/svg+xml" href="/logo.svg" />
      <link rel="stylesheet" href="/web/style.css" />
      <style>
        body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #000; color: #ededed; }
        .auth-card { background: #0a0a0a; border: 1px solid #222225; padding: 40px 36px; border-radius: 16px; max-width: 440px; width: 100%; }
      </style>
    </head>
    <body>
      <div class="auth-card">
        <div style="text-align:center;margin-bottom:24px;">
          <img src="/logo.svg" alt="Krix" style="width:48px;height:48px;margin-bottom:12px;" />
          <h2 style="font-size:22px;font-weight:700;">Authorize AI Client</h2>
          <p style="font-size:13.5px;color:#a1a1aa;margin-top:4px;"><strong>${escapeHtml(client?.clientName || client_id || 'AI Agent')}</strong> is requesting access to Krix</p>
        </div>

        <div style="background:#111113;border:1px solid #1f1f23;padding:16px;border-radius:10px;margin-bottom:24px;font-size:13px;">
          <div style="color:#71717a;margin-bottom:6px;">Connecting as:</div>
          <div style="font-weight:600;color:#ffffff;">${escapeHtml(user.email)}</div>
          <div style="margin-top:12px;color:#71717a;">Requested Scopes:</div>
          <div style="color:#34d399;font-family:monospace;font-size:12px;margin-top:4px;">${escapeHtml(scope || 'mcp:full (GitHub, Render, Sandbox)')}</div>
        </div>

        <form method="POST" action="/api/auth/oauth/consent">
          <input type="hidden" name="client_id" value="${escapeHtml(client_id || '')}" />
          <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri || '')}" />
          <input type="hidden" name="scope" value="${escapeHtml(scope || 'mcp:full')}" />
          <input type="hidden" name="state" value="${escapeHtml(state || '')}" />
          <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge || '')}" />
          <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method || 'S256')}" />

          <div style="display:flex;gap:12px;">
            <button type="submit" name="decision" value="deny" class="btn btn-secondary" style="flex:1;">Cancel</button>
            <button type="submit" name="decision" value="allow" class="btn btn-primary" style="flex:1;">Authorize</button>
          </div>
        </form>
      </div>
    </body>
    </html>
  `);
});

oauthRouter.post('/consent', async (req: Request, res: Response): Promise<void> => {
  const { decision, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.body;

  if (!isRedirectAllowed(client_id, redirect_uri)) {
    res.status(400).send('Invalid or unauthorized redirect_uri.');
    return;
  }

  if (decision !== 'allow') {
    if (redirect_uri) {
      res.redirect(`${redirect_uri}?error=access_denied&state=${encodeURIComponent(state || '')}`);
    } else {
      res.send('Access Denied.');
    }
    return;
  }

  const token = req.cookies?.krix_access_token;
  if (!token) {
    res.status(401).send('Session expired. Please sign in again.');
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    const authCode = `krix_code_${crypto.randomBytes(24).toString('base64url')}`;

    authCodes.set(authCode, {
      code: authCode,
      clientId: client_id || 'default',
      userId: payload.userId,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
      scope: scope || 'mcp:full',
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    const targetRedirect = redirect_uri || 'http://localhost:3000/oauth/callback';
    const delimiter = targetRedirect.includes('?') ? '&' : '?';
    res.redirect(`${targetRedirect}${delimiter}code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state || '')}`);
  } catch (err: any) {
    res.status(500).send('Authorization failed. Please try again.');
  }
});

oauthRouter.post('/token', async (req: Request, res: Response): Promise<void> => {
  const { grant_type, code, code_verifier, refresh_token, client_id } = req.body;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  if (grant_type === 'authorization_code') {
    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code parameter is missing.' });
      return;
    }

    const entry = authCodes.get(code);
    if (!entry) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' });
      return;
    }

    if (Date.now() > entry.expiresAt) {
      authCodes.delete(code);
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code has expired.' });
      return;
    }

    if (entry.codeChallenge) {
      if (!code_verifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required for PKCE.' });
        return;
      }
      const valid = verifyPKCE(code_verifier, entry.codeChallenge, entry.codeChallengeMethod);
      if (!valid) {
        authCodes.delete(code);
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE code_verifier verification failed.' });
        return;
      }
    }

    authCodes.delete(code);

    const user = await UserRepository.findById(entry.userId);
    if (!user) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'User not found.' });
      return;
    }

    const familyId = crypto.randomUUID();
    const newRefreshToken = `krix_rt_${crypto.randomBytes(32).toString('base64url')}`;
    const accessToken = jwt.sign(
      { userId: user._id || user.id, email: user.email, scope: entry.scope, familyId },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    refreshFamilies.set(familyId, {
      familyId,
      userId: user._id || user.id,
      clientId: entry.clientId,
      scope: entry.scope,
      activeToken: newRefreshToken,
      usedTokens: new Set(),
      expiresAt: Date.now() + 30 * 86400 * 1000
    });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: newRefreshToken,
      scope: entry.scope
    });
    return;
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token parameter is missing.' });
      return;
    }

    let matchedFamily: RefreshTokenFamily | undefined;
    for (const fam of refreshFamilies.values()) {
      if (fam.activeToken === refresh_token || fam.usedTokens.has(refresh_token)) {
        matchedFamily = fam;
        break;
      }
    }

    if (!matchedFamily) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown refresh token.' });
      return;
    }

    if (matchedFamily.usedTokens.has(refresh_token)) {
      refreshFamilies.delete(matchedFamily.familyId);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Refresh token reuse detected. Revoked all tokens in family for security.'
      });
      return;
    }

    if (Date.now() > matchedFamily.expiresAt) {
      refreshFamilies.delete(matchedFamily.familyId);
      res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired.' });
      return;
    }

    matchedFamily.usedTokens.add(refresh_token);
    const nextRefreshToken = `krix_rt_${crypto.randomBytes(32).toString('base64url')}`;
    matchedFamily.activeToken = nextRefreshToken;

    const user = await UserRepository.findById(matchedFamily.userId);
    const accessToken = jwt.sign(
      { userId: matchedFamily.userId, email: user?.email, scope: matchedFamily.scope, familyId: matchedFamily.familyId },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: nextRefreshToken,
      scope: matchedFamily.scope
    });
    return;
  }

  res.status(400).json({ error: 'unsupported_grant_type', error_description: `Grant type '${grant_type}' is not supported.` });
});

oauthRouter.post('/revoke', (req: Request, res: Response): void => {
  const { token } = req.body;
  if (token) {
    for (const [id, fam] of refreshFamilies.entries()) {
      if (fam.activeToken === token || fam.usedTokens.has(token)) {
        refreshFamilies.delete(id);
        break;
      }
    }
  }
  res.status(200).json({ status: 'revoked' });
});

import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadSettings } from '../config/settings.js';

export const wellKnownRouter = Router();

const publicDir = path.resolve(process.cwd(), 'public');

const serveAsset = (fileName: string, mimeType: string) => (req: Request, res: Response): void => {
  const filePath = path.join(publicDir, fileName);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.status(404).send('Asset Not Found');
  }
};

wellKnownRouter.get('/logo.png', serveAsset('logo.png', 'image/png'));
wellKnownRouter.get('/logo.svg', serveAsset('logo.svg', 'image/svg+xml'));
wellKnownRouter.get('/icon.png', serveAsset('icon.png', 'image/png'));
wellKnownRouter.get('/favicon.ico', serveAsset('favicon.ico', 'image/x-icon'));
wellKnownRouter.get('/favicon.png', serveAsset('favicon.png', 'image/png'));
wellKnownRouter.get('/apple-touch-icon.png', serveAsset('apple-touch-icon.png', 'image/png'));

wellKnownRouter.get('/assets/:file', (req: Request, res: Response): void => {
  const safeFile = path.basename(String(req.params.file));
  const filePath = path.join(publicDir, safeFile);
  if (fs.existsSync(filePath)) {
    const ext = path.extname(safeFile).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.json': 'application/json'
    };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).send('Error reading asset');
    });
    stream.pipe(res);
  } else {
    res.status(404).send('Not Found');
  }
});

wellKnownRouter.get('/.well-known/oauth-authorization-server', (req: Request, res: Response): void => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/auth/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/auth/oauth/token`,
    registration_endpoint: `${baseUrl}/api/auth/oauth/register`,
    revocation_endpoint: `${baseUrl}/api/auth/oauth/revoke`,
    userinfo_endpoint: `${baseUrl}/api/auth/me`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'email', 'profile', 'mcp:full', 'mcp:tools', 'mcp:read', 'mcp:write'],
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ['en'],
    icon_uri: `${baseUrl}/logo.svg`,
    logo_uri: `${baseUrl}/logo.svg`
  });
});

wellKnownRouter.get('/.well-known/oauth-protected-resource', (req: Request, res: Response): void => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp:full', 'mcp:tools', 'mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header', 'query'],
    resource_documentation: `${baseUrl}/docs`
  });
});

wellKnownRouter.get('/.well-known/mcp.json', (req: Request, res: Response): void => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json({
    schema_version: '1.0',
    name: 'krix',
    display_name: 'Krix',
    description: 'Enterprise Model Context Protocol gateway with multi-runtime execution sandbox, granular tool policies, TOTP 2FA, and Gmail security forensics.',
    version: '2.0.0',
    homepage: baseUrl,
    documentation: `${baseUrl}/docs`,
    policy: `${baseUrl}/policy`,
    icon: `${baseUrl}/logo.svg`,
    icon_svg: `${baseUrl}/logo.svg`,
    branding: {
      color: '#000000',
      theme: 'dark',
      logo_svg_url: `${baseUrl}/logo.svg`,
      logo_png_url: `${baseUrl}/logo.png`,
      icon_url: `${baseUrl}/icon.png`
    },
    transport: {
      type: 'streamable_http',
      endpoint: `${baseUrl}/mcp`,
      sse_endpoint: `${baseUrl}/mcp`
    },
    authentication: {
      type: 'oauth2',
      discovery_endpoint: `${baseUrl}/.well-known/oauth-authorization-server`,
      supported_methods: ['bearer_token', 'x-api-key', 'pkce_oauth']
    },
    capabilities: {
      tools: { dynamic_loading: true, list_changed: true },
      sandbox: { runtimes: ['py', 'js', 'ts', 'sh', 'go', 'java', 'cpp'] },
      github: { enabled: true },
      render: { enabled: true }
    }
  });
});

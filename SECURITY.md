# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 2.0.x   | ✅        |
| < 2.0   | ❌        |

## Reporting a Vulnerability

If you discover a security vulnerability in Krix, please report it responsibly:

1. **Do NOT** open a public GitHub issue for security vulnerabilities.
2. Send a detailed report to the repository owner via GitHub private vulnerability reporting.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Security Measures

Krix implements the following security controls:

- **Authentication**: bcrypt password hashing (cost factor 12), JWT with short-lived access tokens (15min), TOTP 2FA
- **Authorization**: Per-tool permission levels (READ_ONLY, MUTATING, ADMIN), category-based tool access control
- **Encryption**: AES-256-GCM for stored credentials, HMAC-SHA256 for API key hashing
- **Transport**: HTTPS enforced in production, HSTS headers, secure cookie settings
- **Rate Limiting**: Global request throttling, per-endpoint auth rate limits, OAuth rate limiting
- **Sandbox**: Isolated ephemeral directories, command sanitization, dangerous pattern blocking, process timeout enforcement
- **OAuth 2.1**: PKCE (S256 only), refresh token rotation with family-based reuse detection, redirect_uri validation
- **Monitoring**: Audit logging for all security events, new IP login alerts, API key creation notifications
- **Content Security**: Helmet security headers, strict CSP, XSS prevention, HTML escaping
- **Input Validation**: Path traversal prevention, null byte rejection, shell injection blocking, email validation, password strength requirements

## Security Headers

All responses include:
- `Content-Security-Policy`
- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0` (CSP is used instead)
- `Referrer-Policy: strict-origin-when-cross-origin`

## Environment Variables

All security-critical secrets **must** be set via environment variables. The application will refuse to start or operate without:

- `JWT_SECRET` — Required for token signing/verification
- `ENCRYPTION_KEY` — Required for credential encryption (AES-256-GCM)
- `MCP_MASTER_API_KEY` — Required for master API authentication
- `API_KEY_HASH_SALT` — Used for HMAC-based API key hashing

See `.env.example` for the complete configuration reference.

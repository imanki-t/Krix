import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import axios from 'axios';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import rateLimit from 'express-rate-limit';

import { UserRepository } from '../models/User.js';
import { AuditLogRepository } from '../models/AuditLog.js';
import { sendNewIpLoginAlert } from '../services/emailService.js';
import { loadSettings } from '../config/settings.js';

export const authRouter = Router();

const settings = loadSettings();

const authLimiter = rateLimit({
  windowMs: settings.rateLimiting.authWindowMs || 900000,
  max: settings.rateLimiting.authMaxRequests || 20,
  message: { error: 'Too many authentication attempts. Please try again later.' }
});
authRouter.use(authLimiter);

const JWT_SECRET: jwt.Secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('[FATAL] JWT_SECRET required in production'); })() : 'krix-dev-jwt-secret-fallback-key-2026');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function generateToken(user: any): string {
  return jwt.sign(
    { userId: user._id || user.id, email: user.email, securityTier: user.securityTier, type: 'access' },
    JWT_SECRET,
    { expiresIn: '15m', issuer: 'krix', audience: 'krix-api' }
  );
}

function generateRefreshToken(user: any): string {
  return jwt.sign(
    { userId: user._id || user.id, type: 'refresh', jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function verifyRecaptcha(token: string | undefined): Promise<boolean> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey) {
    // reCAPTCHA is not configured in this deployment
    return true;
  }
  if (!token) {
    return false;
  }

  try {
    const res = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      new URLSearchParams({ secret: secretKey, response: token }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 }
    );
    return Boolean(res.data.success && (res.data.score === undefined || res.data.score >= 0.5));
  } catch (err) {
    console.error('[reCAPTCHA] Verification API error (failing closed):', (err as Error).message);
    return false;
  }
}

export const requireAuth = async (req: Request, res: Response, next: any): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.krix_access_token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required. No bearer token or session cookie.' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'krix', audience: 'krix-api' }) as any;
    if (payload.type !== 'access') {
      res.status(401).json({ error: 'Invalid token type. Bearer access token required.' });
      return;
    }
    const user = await UserRepository.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User account not found.' });
      return;
    }
    (req as any).user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session token.' });
  }
};

import {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  hashToken,
  generateOpaqueRefreshToken
} from '../services/cryptoService.js';
import { RefreshTokenRepository } from '../models/RefreshToken.js';

authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, recaptchaToken } = req.body;
    if (!email || !password || !name) {
      res.status(400).json({ error: 'Name, email, and password are required.' });
      return;
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email) || email.length > 254) {
      res.status(400).json({ error: 'Invalid email address format.' });
      return;
    }

    if (name.length > 100 || name.length < 1) {
      res.status(400).json({ error: 'Name must be between 1 and 100 characters.' });
      return;
    }

    if (!(await verifyRecaptcha(recaptchaToken))) {
      res.status(403).json({ error: 'reCAPTCHA verification failed. Bot traffic intercepted.' });
      return;
    }

    const existing = await UserRepository.findByEmail(email);
    if (existing) {
      res.status(400).json({ error: 'Registration could not be completed with the provided credentials. If you already have an account, please sign in.' });
      return;
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,128}$/;
    if (!passwordRegex.test(password)) {
      res.status(400).json({
        error: 'Password must be 10-128 characters with at least one uppercase, one lowercase, one digit, and one special character.'
      });
      return;
    }

    // Mathematical one-way memory-hard password transformation (Scrypt + Pepper)
    const passwordHash = await hashPassword(password);
    const ip = getIp(req);
    const user = await UserRepository.create({
      email,
      passwordHash,
      name,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      knownIps: [ip]
    });

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'USER_REGISTER',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      status: 'SUCCESS'
    });

    const accessToken = generateToken(user);
    const { rawToken, tokenHash, familyId } = generateOpaqueRefreshToken();
    await RefreshTokenRepository.create({
      tokenHash,
      userId: user._id || user.id,
      familyId,
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
    });

    const secureCookie = process.env.NODE_ENV === 'production';
    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 15 * 60 * 1000, path: '/' });
    res.cookie('krix_refresh_token', rawToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 7 * 86400 * 1000, path: '/api/auth' });

    res.status(201).json({
      message: 'Account registered successfully.',
      user: { id: user._id || user.id, email: user.email, name: user.name, securityTier: user.securityTier },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, totpToken, recaptchaToken } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    if (!(await verifyRecaptcha(recaptchaToken))) {
      res.status(403).json({ error: 'reCAPTCHA bot verification failed.' });
      return;
    }

    const user = await UserRepository.findByEmail(email);

    // Account lockout enforcement
    if (user && user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
      const minutesRemaining = Math.ceil((new Date(user.lockoutUntil).getTime() - Date.now()) / 60000);
      res.status(429).json({
        error: `Account is temporarily locked due to consecutive failed attempts. Please try again in ${minutesRemaining} minutes.`
      });
      return;
    }

    // Constant-time dummy compare to prevent email enumeration timing side-channels
    const DUMMY_HASH = '$scrypt$v=1$N=16384,r=8,p=1$e8ukB.c3bYl8vL8XjYl8ve8ukB.c3bYl8vL8XjYl8ve8ukB.c3bY$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hashToCompare = user?.passwordHash || DUMMY_HASH;
    const { valid, needsUpgrade } = await verifyPassword(password, hashToCompare);

    if (!user || !user.passwordHash || !valid) {
      if (user) {
        const attempts = (user.failedLoginAttempts || 0) + 1;
        const updates: Partial<any> = { failedLoginAttempts: attempts };
        if (attempts >= 5) {
          updates.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000);
          await AuditLogRepository.record({
            userId: user._id || user.id,
            action: 'USER_ACCOUNT_LOCKED',
            ipAddress: getIp(req),
            userAgent: req.headers['user-agent'],
            status: 'FAILURE'
          });
        }
        await UserRepository.updateById(user._id || user.id, updates);
      }

      await AuditLogRepository.record({
        userId: user?._id || user?.id,
        action: 'USER_LOGIN_FAILED',
        ipAddress: getIp(req),
        userAgent: req.headers['user-agent'],
        status: 'FAILURE'
      });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    // Reset failed attempts and upgrade legacy password hash if needed
    const userUpdates: Partial<any> = { failedLoginAttempts: 0, lockoutUntil: null };
    if (needsUpgrade) {
      userUpdates.passwordHash = await hashPassword(password);
    }
    await UserRepository.updateById(user._id || user.id, userUpdates);

    if (user.isTotpEnabled && user.totpSecret) {
      if (!totpToken) {
        res.status(200).json({ require2FA: true, message: 'Two-Factor Authentication token required.' });
        return;
      }
      const verified = speakeasy.totp.verify({
        secret: user.totpSecret,
        encoding: 'base32',
        token: totpToken,
        window: 1
      });
      if (!verified) {
        await AuditLogRepository.record({
          userId: user._id || user.id,
          action: 'USER_LOGIN_2FA_FAILED',
          ipAddress: getIp(req),
          userAgent: req.headers['user-agent'],
          status: 'FAILURE'
        });
        res.status(401).json({ error: 'Invalid 2FA code.' });
        return;
      }
    }

    const ip = getIp(req);
    const isNewIp = !user.knownIps?.includes(ip);
    if (isNewIp) {
      const updatedIps = [...(user.knownIps || []), ip];
      await UserRepository.updateById(user._id || user.id, { knownIps: updatedIps });
      sendNewIpLoginAlert({
        email: user.email,
        name: user.name,
        ipAddress: ip,
        userAgent: req.headers['user-agent'] || 'Unknown Browser',
        timestamp: new Date()
      }).catch(console.error);
    }

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'USER_LOGIN_SUCCESS',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      status: 'SUCCESS'
    });

    const accessToken = generateToken(user);
    const { rawToken, tokenHash, familyId } = generateOpaqueRefreshToken();
    await RefreshTokenRepository.create({
      tokenHash,
      userId: user._id || user.id,
      familyId,
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
    });

    const secureCookie = process.env.NODE_ENV === 'production';
    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 15 * 60 * 1000, path: '/' });
    res.cookie('krix_refresh_token', rawToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 7 * 86400 * 1000, path: '/api/auth' });

    res.json({
      message: 'Authenticated successfully.',
      user: { id: user._id || user.id, email: user.email, name: user.name, securityTier: user.securityTier, isTotpEnabled: user.isTotpEnabled },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

authRouter.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawRefreshToken = req.cookies?.krix_refresh_token || req.body?.refreshToken;
    if (!rawRefreshToken) {
      res.status(401).json({ error: 'Refresh token required.' });
      return;
    }

    // Support both opaque hashed tokens and legacy JWT refresh tokens
    let userId: string | null = null;
    let familyId: string | null = null;
    let oldTokenDoc: any = null;

    if (rawRefreshToken.startsWith('krix_rt_')) {
      const incomingHash = hashToken(rawRefreshToken);
      oldTokenDoc = await RefreshTokenRepository.findByHash(incomingHash);

      if (!oldTokenDoc) {
        res.status(401).json({ error: 'Invalid refresh token.' });
        return;
      }

      if (oldTokenDoc.revoked) {
        // Token reuse breach detected: revoke entire family immediately
        await RefreshTokenRepository.revokeFamily(oldTokenDoc.familyId);
        await AuditLogRepository.record({
          userId: oldTokenDoc.userId,
          action: 'REFRESH_TOKEN_REUSE_BREACH_DETECTED',
          ipAddress: getIp(req),
          userAgent: req.headers['user-agent'],
          status: 'FAILURE'
        });
        res.status(401).json({ error: 'Token reuse anomaly detected. All active sessions invalidated for security.' });
        return;
      }

      if (new Date() > new Date(oldTokenDoc.expiresAt)) {
        res.status(401).json({ error: 'Expired refresh token.' });
        return;
      }

      userId = oldTokenDoc.userId;
      familyId = oldTokenDoc.familyId;
    } else {
      // Legacy JWT fallback
      const payload = jwt.verify(rawRefreshToken, JWT_SECRET) as any;
      if (payload.type !== 'refresh') {
        res.status(401).json({ error: 'Invalid refresh token payload.' });
        return;
      }
      userId = payload.userId;
    }

    if (!userId) {
      res.status(401).json({ error: 'Invalid refresh token.' });
      return;
    }

    const user = await UserRepository.findById(userId);
    if (!user) {
      res.status(401).json({ error: 'User account not found.' });
      return;
    }

    const accessToken = generateToken(user);
    const { rawToken: newRawToken, tokenHash: newHash, familyId: newFamily } = generateOpaqueRefreshToken();

    if (oldTokenDoc) {
      await RefreshTokenRepository.revokeByHash(oldTokenDoc.tokenHash, newHash);
    }
    await RefreshTokenRepository.create({
      tokenHash: newHash,
      userId: user._id || user.id,
      familyId: familyId || newFamily,
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
    });

    const secureCookie = process.env.NODE_ENV === 'production';
    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 15 * 60 * 1000, path: '/' });
    res.cookie('krix_refresh_token', newRawToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 7 * 86400 * 1000, path: '/api/auth' });

    res.json({
      message: 'Token refreshed and rotated successfully.',
      accessToken,
      refreshToken: newRawToken
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired refresh token.' });
  }
});

authRouter.post('/google', async (req: Request, res: Response): Promise<void> => {
  try {
    const { credential } = req.body;
    if (!credential) {
      res.status(400).json({ error: 'Missing Google ID credential token.' });
      return;
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(400).json({ error: 'Invalid Google identity payload.' });
      return;
    }

    let user = await UserRepository.findByEmail(payload.email);
    const ip = getIp(req);

    if (!user) {
      user = await UserRepository.create({
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        googleId: payload.sub,
        avatarUrl: payload.picture,
        knownIps: [ip]
      });
    } else if (!user.googleId) {
      user = await UserRepository.updateById(user._id || user.id, {
        googleId: payload.sub,
        avatarUrl: payload.picture || user.avatarUrl
      });
    }

    const isNewIp = !user.knownIps?.includes(ip);
    if (isNewIp) {
      const updatedIps = [...(user.knownIps || []), ip];
      await UserRepository.updateById(user._id || user.id, { knownIps: updatedIps });
      sendNewIpLoginAlert({
        email: user.email,
        name: user.name,
        ipAddress: ip,
        userAgent: req.headers['user-agent'] || 'Google OAuth Sign-in',
        timestamp: new Date()
      }).catch(console.error);
    }

    const accessToken = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    const secureCookie = process.env.NODE_ENV === 'production';
    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 15 * 60 * 1000, path: '/' });
    res.cookie('krix_refresh_token', refreshToken, { httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: 7 * 86400 * 1000, path: '/api/auth' });

    res.json({
      message: 'Google Sign-In successful.',
      user: { id: user._id || user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, securityTier: user.securityTier },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Google authentication failed. Please try again.' });
  }
});

authRouter.get('/me', requireAuth, (req: Request, res: Response): void => {
  const user = (req as any).user;
  res.json({
    id: user._id || user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    securityTier: user.securityTier,
    isTotpEnabled: Boolean(user.isTotpEnabled),
    hasGithubPat: Boolean(user.encryptedGithubPat),
    hasRenderKey: Boolean(user.encryptedRenderKey)
  });
});

authRouter.post('/2fa/setup', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const secret = speakeasy.generateSecret({
      name: `Krix Enterprise (${user.email})`,
      issuer: 'Krix Enterprise'
    });

    await UserRepository.updateById(user._id || user.id, { pendingTotpSecret: secret.base32 });
    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url || '');

    res.json({
      secret: secret.base32,
      qrCodeDataUrl
    });
  } catch (err: any) {
    res.status(500).json({ error: '2FA setup failed. Please try again.' });
  }
});

authRouter.post('/2fa/verify', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { token } = req.body;
    const secretToVerify = user.pendingTotpSecret || user.totpSecret;

    if (!token || !secretToVerify) {
      res.status(400).json({ error: '2FA token and secret are required.' });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: secretToVerify,
      encoding: 'base32',
      token,
      window: 1
    });

    if (!verified) {
      res.status(400).json({ error: 'Invalid 2FA verification token.' });
      return;
    }

    await UserRepository.updateById(user._id || user.id, {
      isTotpEnabled: true,
      totpSecret: secretToVerify,
      pendingTotpSecret: undefined
    });

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: '2FA_ENABLED',
      ipAddress: getIp(req),
      userAgent: req.headers['user-agent'],
      status: 'SUCCESS'
    });

    res.json({ message: 'Two-factor authentication enabled successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: '2FA verification failed. Please try again.' });
  }
});

authRouter.post('/2fa/disable', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { token } = req.body;

    if (!token || !user.totpSecret) {
      res.status(400).json({ error: '2FA token is required.' });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token,
      window: 1
    });

    if (!verified) {
      res.status(400).json({ error: 'Invalid 2FA token.' });
      return;
    }

    await UserRepository.updateById(user._id || user.id, { isTotpEnabled: false, totpSecret: undefined, pendingTotpSecret: undefined });

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: '2FA_DISABLED',
      ipAddress: getIp(req),
      userAgent: req.headers['user-agent'],
      status: 'SUCCESS'
    });

    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (err: any) {
    res.status(500).json({ error: '2FA disable failed. Please try again.' });
  }
});

authRouter.post('/logout', (req: Request, res: Response): void => {
  const secureCookie = process.env.NODE_ENV === 'production';
  res.clearCookie('krix_access_token', { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/' });
  res.clearCookie('krix_refresh_token', { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/api/auth' });
  res.json({ message: 'Logged out successfully.' });
});

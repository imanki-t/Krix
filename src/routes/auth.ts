import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import axios from 'axios';
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

const JWT_SECRET = process.env.JWT_SECRET || 'krix_jwt_super_secret_signing_key_at_least_32_chars!';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function generateToken(user: any): string {
  return jwt.sign(
    { userId: user._id || user.id, email: user.email, securityTier: user.securityTier },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function generateRefreshToken(user: any): string {
  return jwt.sign(
    { userId: user._id || user.id, tokenVersion: '1' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function verifyRecaptcha(token: string | undefined): Promise<boolean> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey || !token) {
    return true;
  }

  try {
    const res = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`
    );
    return res.data.success && (res.data.score === undefined || res.data.score >= 0.5);
  } catch (err) {
    console.error('[reCAPTCHA] Verification error:', err);
    return true;
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
    const payload = jwt.verify(token, JWT_SECRET) as any;
    const user = await UserRepository.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User account not found.' });
      return;
    }
    (req as any).user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
};

authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, recaptchaToken } = req.body;
    if (!email || !password || !name) {
      res.status(400).json({ error: 'Name, email, and password are required.' });
      return;
    }

    if (!(await verifyRecaptcha(recaptchaToken))) {
      res.status(403).json({ error: 'reCAPTCHA verification failed. Bot traffic intercepted.' });
      return;
    }

    const existing = await UserRepository.findByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'An account with this email address already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const ip = getIp(req);
    const user = await UserRepository.create({
      email,
      passwordHash,
      name,
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
    const refreshToken = generateRefreshToken(user);

    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 15 * 60 * 1000 });
    res.cookie('krix_refresh_token', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400 * 1000 });

    res.status(201).json({
      message: 'Account registered successfully.',
      user: { id: user._id || user.id, email: user.email, name: user.name, securityTier: user.securityTier },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Registration failed.' });
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
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      await AuditLogRepository.record({
        userId: user._id || user.id,
        action: 'USER_LOGIN_FAILED',
        ipAddress: getIp(req),
        userAgent: req.headers['user-agent'],
        status: 'FAILURE'
      });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

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
    const refreshToken = generateRefreshToken(user);

    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 15 * 60 * 1000 });
    res.cookie('krix_refresh_token', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400 * 1000 });

    res.json({
      message: 'Authenticated successfully.',
      user: { id: user._id || user.id, email: user.email, name: user.name, securityTier: user.securityTier, isTotpEnabled: user.isTotpEnabled },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Login failed.' });
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

    res.cookie('krix_access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 15 * 60 * 1000 });
    res.cookie('krix_refresh_token', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400 * 1000 });

    res.json({
      message: 'Google Sign-In successful.',
      user: { id: user._id || user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, securityTier: user.securityTier },
      accessToken
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Google authentication failed.' });
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

    await UserRepository.updateById(user._id || user.id, { totpSecret: secret.base32 });
    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url || '');

    res.json({
      secret: secret.base32,
      qrCodeDataUrl
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '2FA setup failed.' });
  }
});

authRouter.post('/2fa/verify', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { token } = req.body;

    if (!token || !user.totpSecret) {
      res.status(400).json({ error: '2FA token and secret are required.' });
      return;
    }

    const verified = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token,
      window: 1
    });

    if (!verified) {
      res.status(400).json({ error: 'Invalid 2FA verification token.' });
      return;
    }

    await UserRepository.updateById(user._id || user.id, { isTotpEnabled: true });
    res.json({ message: 'Two-factor authentication enabled successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '2FA verification failed.' });
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

    await UserRepository.updateById(user._id || user.id, { isTotpEnabled: false, totpSecret: undefined });
    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '2FA disable failed.' });
  }
});

authRouter.post('/logout', (req: Request, res: Response): void => {
  res.clearCookie('krix_access_token');
  res.clearCookie('krix_refresh_token');
  res.json({ message: 'Logged out successfully.' });
});

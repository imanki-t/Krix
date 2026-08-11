import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { UserRepository } from '../models/User.js';
import { AuditLogRepository } from '../models/AuditLog.js';
import { encryptSecret } from '../services/cryptoService.js';
import { loadSettings, saveSettings, SecurityTier } from '../config/settings.js';

export const settingsRouter = Router();

settingsRouter.get('/public', (req: Request, res: Response): void => {
  const s = loadSettings();
  res.json({
    securityTier: s.security.currentTier,
    rateLimiting: s.rateLimiting,
    sandbox: s.sandbox,
    quotas: s.quotas
  });
});

settingsRouter.use(requireAuth);

settingsRouter.post('/tier', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { tier } = req.body;

    if (!Object.values(SecurityTier).includes(tier)) {
      res.status(400).json({ error: `Invalid security tier: '${tier}'. Choose STANDARD, STRICT, or FORTRESS.` });
      return;
    }

    await UserRepository.updateById(user._id || user.id, { securityTier: tier });
    saveSettings({ security: { ...loadSettings().security, currentTier: tier } });

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'SECURITY_TIER_UPDATED',
      ipAddress: req.ip || '127.0.0.1',
      details: { newTier: tier }
    });

    res.json({ message: `Security tier set to ${tier}.`, securityTier: tier });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update security tier.' });
  }
});

settingsRouter.post('/integrations', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { githubPat, renderKey } = req.body;
    const updates: any = {};

    if (githubPat !== undefined) {
      updates.encryptedGithubPat = githubPat ? encryptSecret(githubPat.trim()) : '';
    }
    if (renderKey !== undefined) {
      updates.encryptedRenderKey = renderKey ? encryptSecret(renderKey.trim()) : '';
    }

    await UserRepository.updateById(user._id || user.id, updates);
    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'INTEGRATIONS_UPDATED',
      ipAddress: req.ip || '127.0.0.1',
      details: { updatedGithub: githubPat !== undefined, updatedRender: renderKey !== undefined }
    });

    res.json({
      message: 'Integration credentials encrypted and saved successfully.',
      hasGithubPat: Boolean(updates.encryptedGithubPat || user.encryptedGithubPat),
      hasRenderKey: Boolean(updates.encryptedRenderKey || user.encryptedRenderKey)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update integrations.' });
  }
});

settingsRouter.get('/audit-logs', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const logs = await AuditLogRepository.listByUser(user._id || user.id, 50);
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch audit logs.' });
  }
});

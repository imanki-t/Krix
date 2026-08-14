import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { ApiKeyRepository } from '../models/ApiKey.js';
import { AuditLogRepository } from '../models/AuditLog.js';
import { generateRawApiKey } from '../services/cryptoService.js';
import { sendApiKeyCreatedAlert } from '../services/emailService.js';
import { loadSettings } from '../config/settings.js';

export const keysRouter = Router();

keysRouter.use(requireAuth);

keysRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const keys = await ApiKeyRepository.listByUser(user._id || user.id);
    res.json({
      keys: keys.map(k => ({
        id: k._id || k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        rateLimitPerMin: k.rateLimitPerMin,
        maxMemoryMB: k.maxMemoryMB,
        totalRequests: k.totalRequests,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list API keys.' });
  }
});

keysRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const settings = loadSettings();
    const currentCount = await ApiKeyRepository.countByUser(user._id || user.id);

    if (currentCount >= (settings.quotas.maxKeysPerUser || 3)) {
      res.status(403).json({
        error: `Quota exceeded. You can only generate up to ${settings.quotas.maxKeysPerUser || 3} active MCP API keys.`
      });
      return;
    }

    const { rateLimitPerMin, maxMemoryMB } = req.body;
    const rawName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!rawName || rawName.length > 100) {
      res.status(400).json({ error: 'API Key name must be between 1 and 100 characters.' });
      return;
    }
    const name = rawName;

    const { rawKey, keyPrefix, keyHash } = generateRawApiKey();
    const doc = await ApiKeyRepository.create({
      userId: user._id || user.id,
      name,
      keyPrefix,
      keyHash,
      rateLimitPerMin: Math.min(Math.max(1, Number(rateLimitPerMin) || settings.rateLimiting.defaultKeyRateLimitPerMin || 60), 1000),
      maxMemoryMB: Math.min(Math.max(128, Number(maxMemoryMB) || settings.sandbox.maxMemoryMB || 512), 4096)
    });

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'API_KEY_CREATED',
      ipAddress: req.ip || '127.0.0.1',
      details: { keyName: name, keyPrefix }
    });

    sendApiKeyCreatedAlert({
      email: user.email,
      keyName: name,
      keyPrefix,
      ipAddress: req.ip || '127.0.0.1'
    }).catch(console.error);

    res.status(201).json({
      message: 'API Key generated successfully. Copy your secret key now; it will not be displayed again.',
      apiKey: {
        id: doc._id || doc.id,
        name: doc.name,
        rawKey,
        keyPrefix: doc.keyPrefix,
        rateLimitPerMin: doc.rateLimitPerMin,
        maxMemoryMB: doc.maxMemoryMB
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create API key.' });
  }
});

keysRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const keyId = String(req.params.id);
    const deleted = await ApiKeyRepository.delete(user._id || user.id, keyId);
    if (!deleted) {
      res.status(404).json({ error: 'API key not found.' });
      return;
    }

    await AuditLogRepository.record({
      userId: user._id || user.id,
      action: 'API_KEY_DELETED',
      ipAddress: req.ip || '127.0.0.1',
      details: { keyId }
    });

    res.json({ message: 'API key revoked successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete API key.' });
  }
});

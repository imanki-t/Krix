import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    if (envKey.length === 64) {
      return Buffer.from(envKey, 'hex');
    }
    return crypto.createHash('sha256').update(envKey).digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[FATAL] ENCRYPTION_KEY environment variable is required in production.');
  }
  return crypto.createHash('sha256').update('krix-dev-fallback-encryption-key').digest();
}

export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  try {
    const iv = crypto.randomBytes(12);
    const key = getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('[Crypto] Encryption error:', err);
    return '';
  }
}

export function decryptSecret(encryptedPayload: string): string {
  if (!encryptedPayload) return '';
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    return encryptedPayload;
  }

  try {
    const [ivHex, authTagHex, encryptedText] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = getEncryptionKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Crypto] Decryption authentication failed (invalid tag or corrupted payload)');
    return '';
  }
}

export function hashApiKey(apiKey: string): string {
  const salt = process.env.API_KEY_HASH_SALT || 'krix-api-key-hash-salt';
  return crypto.createHmac('sha256', salt).update(apiKey).digest('hex');
}

export function generateRawApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const randomBytes = crypto.randomBytes(24).toString('base64url');
  const rawKey = `krix_live_${randomBytes}`;
  const keyPrefix = rawKey.slice(0, 14);
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

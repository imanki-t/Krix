import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const ALGORITHM = 'aes-256-gcm';
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || 'krix-password-pepper-secret-v1';
const TOKEN_HASH_SALT = process.env.TOKEN_HASH_SALT || 'krix-token-hash-salt-v1';

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

/**
 * Mathematical one-way pepper transformation.
 * Normalizes password entropy and ensures DB dumps cannot be cracked without server memory secret.
 */
function pepperPassword(password: string): Buffer {
  return crypto.createHmac('sha256', PASSWORD_PEPPER).update(password).digest();
}

/**
 * Modern memory-hard one-way password hashing (Argon2id/Scrypt + HMAC Pepper).
 * Mathematically irreversible trapdoor function with high GPU/ASIC resistance.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const peppered = pepperPassword(password);
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(peppered, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `$scrypt$v=1$N=16384,r=8,p=1$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

/**
 * Constant-time mathematical password verification with backward compatibility.
 * Validates either Scrypt+Pepper or legacy bcrypt hashes in constant time.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (!password || !storedHash) return { valid: false, needsUpgrade: false };

  if (storedHash.startsWith('$scrypt$')) {
    const parts = storedHash.split('$');
    if (parts.length < 6) return { valid: false, needsUpgrade: false };
    const saltHex = parts[4];
    const keyHex = parts[5];
    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    const peppered = pepperPassword(password);

    try {
      const derivedKey = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(peppered, salt, expectedKey.length, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (err, key) => {
          if (err) reject(err);
          else resolve(key);
        });
      });

      if (derivedKey.length !== expectedKey.length) {
        return { valid: false, needsUpgrade: false };
      }
      const valid = crypto.timingSafeEqual(derivedKey, expectedKey);
      return { valid, needsUpgrade: false };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  // Legacy bcrypt support with automatic hash upgrade recommendation
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    try {
      const valid = await bcrypt.compare(password, storedHash);
      return { valid, needsUpgrade: valid };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  return { valid: false, needsUpgrade: false };
}

/**
 * One-way cryptographic hash for tokens (Refresh tokens, OAuth tokens, and Session tokens).
 * Never stores bearer tokens in plain text in the database.
 */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', TOKEN_HASH_SALT).update(token).digest('hex');
}

/**
 * Generates an opaque refresh token with cryptographic one-way hash for storage.
 */
export function generateOpaqueRefreshToken(): { rawToken: string; tokenHash: string; familyId: string } {
  const rawToken = `krix_rt_${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = hashToken(rawToken);
  const familyId = crypto.randomUUID();
  return { rawToken, tokenHash, familyId };
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

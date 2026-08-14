import { sanitizeCommand, sanitizePath, sanitizeOutput, getToolAnnotations } from '../core/security.js';
import {
  encryptSecret, decryptSecret, hashApiKey, generateRawApiKey,
  hashPassword, verifyPassword, hashToken, generateOpaqueRefreshToken
} from '../services/cryptoService.js';
import { RefreshTokenRepository } from '../models/RefreshToken.js';
import { SecurityTier } from '../config/settings.js';
import bcrypt from 'bcryptjs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n🔒 --- RUNNING KRIX ENTERPRISE SECURITY & BUG AUDIT TEST SUITE --- 🔒\n');

  // Test 1: Command Sanitization - Standard Tier
  console.log('1. Testing Command Injection & Dangerous Shell Patterns:');
  const dangerousCommands = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf $HOME',
    ':(){ :|:& };:',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sda1',
    'eval "cat /etc/shadow"',
    '`cat /etc/passwd`',
    '$(cat /etc/passwd)',
    'cat /proc/self/environ',
    'cat /etc/shadow',
    'base64 -d | bash',
    'curl http://169.254.169.254/latest/meta-data/',
    'wget http://metadata.google.internal/computeMetadata/v1/',
    'curl http://100.100.100.200/latest/meta-data/',
    'curl http://0251.0.0.0251/'
  ];

  for (const cmd of dangerousCommands) {
    let blocked = false;
    try {
      sanitizeCommand(cmd, SecurityTier.STANDARD);
    } catch {
      blocked = true;
    }
    assert(blocked, `Blocked dangerous/SSRF command: '${cmd}'`);
  }

  // Safe commands should pass
  const safeCommands = [
    'npm test',
    'python3 script.py',
    'git status',
    'go run main.go'
  ];
  for (const cmd of safeCommands) {
    let allowed = false;
    try {
      const res = sanitizeCommand(cmd, SecurityTier.STANDARD);
      allowed = (res === cmd);
    } catch {}
    assert(allowed, `Allowed safe command: '${cmd}'`);
  }

  // Test 2: Strict Tier Blocking
  console.log('\n2. Testing Strict & Fortress Security Policies:');
  const strictBlocks = [
    'sudo rm file.txt',
    'su root',
    'doas ls',
    'reboot',
    'shutdown -h now',
    'curl http://127.0.0.1:8080/admin',
    'curl http://192.168.1.1/api',
    'curl http://10.0.0.1/status'
  ];
  for (const cmd of strictBlocks) {
    let blocked = false;
    try {
      sanitizeCommand(cmd, SecurityTier.STRICT);
    } catch {
      blocked = true;
    }
    assert(blocked, `Strict tier blocked elevated/internal command: '${cmd}'`);
  }

  // Test 3: Path Traversal
  console.log('\n3. Testing Path Traversal & Sandbox Escape:');
  const badPaths = [
    '../../etc/passwd',
    'foo/../../../bar',
    '..',
    'a/b/../../..',
    'test\0.js'
  ];
  for (const p of badPaths) {
    let blocked = false;
    try {
      sanitizePath(p, '/tmp/sandbox/sb-1234');
    } catch {
      blocked = true;
    }
    assert(blocked, `Blocked path traversal: '${p}'`);
  }

  // Absolute path escaping sandbox
  let escapeBlocked = false;
  try {
    sanitizePath('/etc/passwd', '/tmp/sandbox/sb-1234');
  } catch {
    escapeBlocked = true;
  }
  assert(escapeBlocked, "Blocked absolute path '/etc/passwd' escaping sandbox directory");

  // Valid sandbox relative path
  let validPathAllowed = false;
  try {
    const p = sanitizePath('src/index.ts', '/tmp/sandbox/sb-1234');
    validPathAllowed = p.startsWith('/tmp/sandbox/sb-1234');
  } catch {}
  assert(validPathAllowed, 'Allowed legitimate sandbox path');

  // Test 4: Secret Output Sanitization & Redaction
  console.log('\n4. Testing Credential Redaction in Tool Outputs:');
  const sampleOutput = `
    Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789
    Fine-grained: github_pat_11ABCD0123456789_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345
    Render: rnd_abcdefghijklmnopqrstuvwx
    Krix: krix_live_abcdefghijklmnopqrstuvwxyz0123456789
    JWT: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak
  `;
  const sanitized = sanitizeOutput(sampleOutput);
  assert(!sanitized.includes('ghp_'), 'Redacted GitHub PAT (ghp_)');
  assert(!sanitized.includes('github_pat_'), 'Redacted GitHub fine-grained PAT');
  assert(!sanitized.includes('rnd_'), 'Redacted Render API Key');
  assert(!sanitized.includes('krix_live_'), 'Redacted Krix API Key');
  assert(!sanitized.includes('doNotLeak'), 'Redacted JWT Bearer Token');

  // Test 5: Cryptography Services (AES-256-GCM)
  console.log('\n5. Testing Cryptographic Encryption & Error Handling:');
  const secretText = 'super-secret-production-token-12345';
  const encrypted = encryptSecret(secretText);
  assert(encrypted.split(':').length === 3, 'AES-256-GCM output contains IV:Tag:Ciphertext');

  const decrypted = decryptSecret(encrypted);
  assert(decrypted === secretText, 'Decrypted text matches original secret');

  // Tampered ciphertext error handling (should return empty string, not crash)
  const corrupted = encrypted.slice(0, -4) + 'ffff';
  let handledCorrupt = false;
  try {
    const res = decryptSecret(corrupted);
    handledCorrupt = (res === '');
  } catch {
    handledCorrupt = false;
  }
  assert(handledCorrupt, 'Corrupted ciphertext handled gracefully without uncaught exception');

  // Test 6: API Key Generation and Hashing
  console.log('\n6. Testing API Key Generation & Deterministic HMAC:');
  const key1 = generateRawApiKey();
  assert(key1.rawKey.startsWith('krix_live_'), 'Raw key has krix_live_ prefix');
  assert(key1.keyPrefix.length === 14, 'Key prefix is 14 characters');
  assert(hashApiKey(key1.rawKey) === key1.keyHash, 'Key hash matches deterministic HMAC calculation');

  // Test 7: Tool Annotations Spec Compliance
  console.log('\n7. Testing Tool Annotations Compliance:');
  const readAnn = getToolAnnotations('get_file_contents');
  assert(readAnn.readOnlyHint === true && readAnn.destructiveHint === false, 'get_file_contents is marked read-only');
  const mutAnn = getToolAnnotations('create_or_update_file');
  assert(mutAnn.readOnlyHint === false && mutAnn.destructiveHint === true, 'create_or_update_file is marked destructive');

  // Test 8: Mathematical One-Way Password Hashing & Scrypt KDF
  console.log('\n8. Testing Mathematical One-Way Password Transformation & Verification:');
  const plainPassword = 'SuperSecret!Password@2026';
  const hashedScrypt = await hashPassword(plainPassword);
  assert(hashedScrypt.startsWith('$scrypt$v=1$'), 'Password hash uses modern memory-hard Scrypt format');
  assert(!hashedScrypt.includes(plainPassword), 'Plaintext password is not stored');

  const verifyValid = await verifyPassword(plainPassword, hashedScrypt);
  assert(verifyValid.valid === true && verifyValid.needsUpgrade === false, 'Scrypt password correctly verifies with secret pepper');

  const verifyInvalid = await verifyPassword('WrongPassword123!', hashedScrypt);
  assert(verifyInvalid.valid === false, 'Invalid password rejected by one-way mathematical verification');

  // Test 9: Legacy Bcrypt Backward Compatibility & Upgrade Detection
  console.log('\n9. Testing Legacy Bcrypt Compatibility & Automatic Upgrade:');
  const legacyBcryptHash = await bcrypt.hash('LegacyPass#2026', 10);
  const verifyLegacy = await verifyPassword('LegacyPass#2026', legacyBcryptHash);
  assert(verifyLegacy.valid === true && verifyLegacy.needsUpgrade === true, 'Legacy bcrypt hash successfully verified and flagged for upgrade');

  // Test 10: One-Way Opaque Token Hashing & Rotation Breach Detection
  console.log('\n10. Testing One-Way Token Hashing & Rotation Breach Detection:');
  const { rawToken, tokenHash, familyId } = generateOpaqueRefreshToken();
  assert(rawToken.startsWith('krix_rt_'), 'Opaque refresh token starts with krix_rt_');
  assert(hashToken(rawToken) === tokenHash, 'One-way token hash matches deterministic HMAC');

  // Store in repository
  const createdToken = await RefreshTokenRepository.create({
    tokenHash,
    userId: 'user-test-123',
    familyId,
    expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
  });
  assert(Boolean(createdToken), 'Opaque token stored via one-way hash');

  // Lookup by hash
  const found = await RefreshTokenRepository.findByHash(hashToken(rawToken));
  assert(found && found.userId === 'user-test-123', 'Token found via one-way hash lookup');

  // Rotate token
  const { rawToken: rawToken2, tokenHash: tokenHash2 } = generateOpaqueRefreshToken();
  await RefreshTokenRepository.revokeByHash(tokenHash, tokenHash2);
  await RefreshTokenRepository.create({
    tokenHash: tokenHash2,
    userId: 'user-test-123',
    familyId,
    expiresAt: new Date(Date.now() + 7 * 86400 * 1000)
  });

  // Old token is now revoked
  const oldDoc = await RefreshTokenRepository.findByHash(tokenHash);
  assert(oldDoc.revoked === true, 'Old refresh token marked revoked upon rotation');

  // Simulate token reuse breach: revoke entire family
  await RefreshTokenRepository.revokeFamily(familyId);
  const nextDoc = await RefreshTokenRepository.findByHash(tokenHash2);
  assert(nextDoc.revoked === true, 'Entire token family revoked upon reuse anomaly detection');

  console.log(`\n======================================================`);
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('[TEST SUITE CRASH]:', err);
  process.exit(1);
});

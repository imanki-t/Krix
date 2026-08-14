import { sanitizeCommand, sanitizePath, sanitizeOutput, getToolAnnotations } from '../core/security.js';
import { encryptSecret, decryptSecret, hashApiKey, generateRawApiKey } from '../services/cryptoService.js';
import { SecurityTier } from '../config/settings.js';

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
    'base64 -d | bash'
  ];

  for (const cmd of dangerousCommands) {
    let blocked = false;
    try {
      sanitizeCommand(cmd, SecurityTier.STANDARD);
    } catch {
      blocked = true;
    }
    assert(blocked, `Blocked dangerous command: '${cmd}'`);
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
  const strictBlocks = ['sudo rm file.txt', 'su root', 'doas ls', 'reboot', 'shutdown -h now'];
  for (const cmd of strictBlocks) {
    let blocked = false;
    try {
      sanitizeCommand(cmd, SecurityTier.STRICT);
    } catch {
      blocked = true;
    }
    assert(blocked, `Strict tier blocked elevated command: '${cmd}'`);
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

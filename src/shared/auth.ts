import { timingSafeEqual } from 'node:crypto';

// Constant-time string comparison so the MCP_API_KEY check doesn't leak
// timing information through a length/early-exit-dependent comparison
// (the previous `!==` check was not constant-time).
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still touch timingSafeEqual so the failure path takes comparable
    // time regardless of input length, then fall through to false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

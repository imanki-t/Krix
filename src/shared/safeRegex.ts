const SPECIAL_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

/** Escapes regex metacharacters so a literal string can be used as a pattern. */
export function escapeForLiteralSearch(input: string): string {
  return input.replace(SPECIAL_REGEX_CHARS, '\\$&');
}

// Simplified "star height" heuristic: rejects patterns with a quantifier
// nested inside a group that is itself quantified, e.g. (a+)+, (.*)+, (a*)*.
// These are the classic shapes behind catastrophic backtracking / ReDoS.
// Intentionally conservative (may reject some safe patterns) since grep_file
// runs on server-supplied text with no execution timeout in place.
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*]/;
const MAX_PATTERN_LENGTH = 300;

export function isPotentiallyCatastrophic(pattern: string): boolean {
  return pattern.length > MAX_PATTERN_LENGTH || NESTED_QUANTIFIER.test(pattern);
}

export interface CompiledSearch {
  test: (line: string) => boolean;
}

/**
 * Compiles a search query into a safe matcher.
 * - literal=true: query is escaped and matched as plain text.
 * - literal=false: query is treated as regex, rejected if it looks
 *   catastrophic, and falls back to a literal substring match if it
 *   fails to compile or is rejected.
 */
export function compileSafeSearch(query: string, caseSensitive: boolean, literal: boolean): CompiledSearch {
  const flags = caseSensitive ? '' : 'i';

  if (literal) {
    const regex = new RegExp(escapeForLiteralSearch(query), flags);
    return { test: (line: string) => regex.test(line) };
  }

  if (!isPotentiallyCatastrophic(query)) {
    try {
      const regex = new RegExp(query, flags);
      return { test: (line: string) => regex.test(line) };
    } catch {
      // fall through to literal fallback below
    }
  }

  const literalRegex = new RegExp(escapeForLiteralSearch(query), flags);
  return { test: (line: string) => literalRegex.test(line) };
}

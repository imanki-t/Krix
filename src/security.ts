import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';

export enum PermissionLevel {
  READ_ONLY = 'READ_ONLY',
  MUTATING = 'MUTATING',
  ADMIN = 'ADMIN'
}

export interface SessionContext {
  owner?: string;
  repo?: string;
  branch?: string;
  workspaceId?: string;
  sandboxDir?: string;
  cwd?: string;
  env?: Record<string, string>;
  enabledCategories: Set<ToolCategory>;
  resumedContext?: { fromPriorSession: true; idleMs: number };
}

const sessionContexts = new Map<string, SessionContext>();

const sessionAuthKey = new Map<string, string>();
const lastKnownContextByAuth = new Map<string, { owner?: string; repo?: string; branch?: string; sandboxDir?: string; cwd?: string; env?: Record<string, string>; lastUsed: number }>();

const MIN_AUTH_CONTEXT_TTL_MS = 5 * 60 * 1000;
const MAX_AUTH_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTH_CONTEXT_TTL_MS = 60 * 60 * 1000;
function resolveConfiguredTtl(): number {
  const raw = Number(process.env.AUTH_CONTEXT_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTH_CONTEXT_TTL_MS;
  return Math.min(MAX_AUTH_CONTEXT_TTL_MS, Math.max(MIN_AUTH_CONTEXT_TTL_MS, raw));
}
const AUTH_CONTEXT_TTL_MS = resolveConfiguredTtl();

const AUTH_CONTEXT_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const authContextPruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of lastKnownContextByAuth) {
    if (now - bucket.lastUsed > AUTH_CONTEXT_TTL_MS) lastKnownContextByAuth.delete(key);
  }
}, AUTH_CONTEXT_PRUNE_INTERVAL_MS);
authContextPruneTimer.unref();

function hashAuth(token: string): string {
  return crypto.createHash('sha256').update(token || 'anonymous').digest('hex').slice(0, 16);
}

export function registerSessionAuth(sessionId: string, githubToken: string): void {
  sessionAuthKey.set(sessionId, hashAuth(githubToken));
}

export function getAuthKeyForSession(sessionId: string): string {
  return sessionAuthKey.get(sessionId) || 'anonymous';
}

function authBucket(sessionId: string) {
  const key = sessionAuthKey.get(sessionId) || 'anonymous';
  let bucket = lastKnownContextByAuth.get(key);
  if (bucket && Date.now() - bucket.lastUsed > AUTH_CONTEXT_TTL_MS) {
    bucket = undefined;
  }
  if (!bucket) { bucket = { lastUsed: Date.now() }; lastKnownContextByAuth.set(key, bucket); }
  else { bucket.lastUsed = Date.now(); }
  return bucket;
}

export function getSessionContext(sessionId: string): SessionContext {
  if (!sessionContexts.has(sessionId)) {
    const enableAll = process.env.ENABLE_ALL_TOOLS === 'true';

    const enableIssuesPrs = enableAll ||
      process.env.ENABLE_GITHUB_ISSUES_PRS === 'true' ||
      process.env.ENABLE_GITHUB_ISSUES_PRS_TOOLS === 'true';

    const enableAdmin = enableAll ||
      process.env.ENABLE_GITHUB_ADMIN === 'true' ||
      process.env.ENABLE_GITHUB_ADMIN_TOOLS === 'true';

    const enableRender = enableAll ||
      process.env.ENABLE_RENDER === 'true' ||
      process.env.ENABLE_RENDER_TOOLS === 'true';

    const enableSandbox = enableAll || (
      process.env.ENABLE_SANDBOX !== 'false' &&
      process.env.ENABLE_SANDBOX_TOOLS !== 'false' &&
      process.env.DISABLE_SANDBOX !== 'true' &&
      process.env.DISABLE_SANDBOX_TOOLS !== 'true'
    );

    const initial: ToolCategory[] = ['core'];
    if (enableIssuesPrs) initial.push('github_issues_prs');
    if (enableAdmin) initial.push('github_admin');
    if (enableRender) initial.push('render');
    if (enableSandbox) initial.push('sandbox');

    const key = sessionAuthKey.get(sessionId) || 'anonymous';
    const priorRaw = lastKnownContextByAuth.get(key);
    const idleMs = priorRaw ? Date.now() - priorRaw.lastUsed : undefined;
    const hadLiveData = !!priorRaw && idleMs! <= AUTH_CONTEXT_TTL_MS && (priorRaw.owner || priorRaw.repo || priorRaw.branch || priorRaw.sandboxDir);

    const known = authBucket(sessionId);
    sessionContexts.set(sessionId, {
      branch: known.branch || 'main',
      owner: known.owner,
      repo: known.repo,
      sandboxDir: known.sandboxDir,
      cwd: known.cwd,
      env: known.env,
      enabledCategories: new Set(initial),
      ...(hadLiveData ? { resumedContext: { fromPriorSession: true, idleMs: idleMs! } } : {})
    });
  }
  return sessionContexts.get(sessionId)!;
}

export function updateSessionContext(sessionId: string, patch: Partial<SessionContext>): SessionContext {
  const current = getSessionContext(sessionId);
  Object.assign(current, patch);
  const known = authBucket(sessionId);
  if ('owner' in patch) known.owner = patch.owner;
  if ('repo' in patch) known.repo = patch.repo;
  if ('branch' in patch) known.branch = patch.branch;
  if ('sandboxDir' in patch) known.sandboxDir = patch.sandboxDir;
  if ('cwd' in patch) known.cwd = patch.cwd;
  if ('env' in patch) known.env = patch.env;
  return current;
}

export function deleteSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
  sessionAuthKey.delete(sessionId);
}

export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  'set_active_context': PermissionLevel.READ_ONLY,
  'get_me': PermissionLevel.READ_ONLY,
  'get_file_contents': PermissionLevel.READ_ONLY,
  'str_replace_editor': PermissionLevel.MUTATING,
  'create_or_update_file': PermissionLevel.MUTATING,
  'delete_file': PermissionLevel.MUTATING,
  'grep': PermissionLevel.READ_ONLY,
  'view_file_outline': PermissionLevel.READ_ONLY,
  'list_branches': PermissionLevel.READ_ONLY,
  'create_branch': PermissionLevel.MUTATING,
  'delete_branch': PermissionLevel.MUTATING,
  'push_files': PermissionLevel.MUTATING,
  'create_pull_request': PermissionLevel.MUTATING,
  'get_commit': PermissionLevel.READ_ONLY,
  'search_code': PermissionLevel.READ_ONLY,
  'search_commits': PermissionLevel.READ_ONLY,
  'search_repositories': PermissionLevel.READ_ONLY,
  'git_tree': PermissionLevel.READ_ONLY,
  'patch_contents': PermissionLevel.MUTATING,
  'sandbox_status': PermissionLevel.READ_ONLY,

  'list_issues': PermissionLevel.READ_ONLY,
  'list_pull_requests': PermissionLevel.READ_ONLY,
  'issue_read': PermissionLevel.READ_ONLY,
  'issue_write': PermissionLevel.MUTATING,
  'sub_issue_write': PermissionLevel.MUTATING,
  'add_issue_comment': PermissionLevel.MUTATING,
  'pull_request_read': PermissionLevel.READ_ONLY,
  'pull_request_review_write': PermissionLevel.MUTATING,
  'add_comment_to_pending_review': PermissionLevel.MUTATING,
  'add_reply_to_pull_request_comment': PermissionLevel.MUTATING,
  'update_pull_request': PermissionLevel.MUTATING,
  'update_pull_request_branch': PermissionLevel.MUTATING,
  'merge_pull_request': PermissionLevel.MUTATING,
  'search_issues': PermissionLevel.READ_ONLY,
  'search_pull_requests': PermissionLevel.READ_ONLY,

  'get_label': PermissionLevel.READ_ONLY,
  'get_release': PermissionLevel.READ_ONLY,
  'get_tag': PermissionLevel.READ_ONLY,
  'get_team_members': PermissionLevel.READ_ONLY,
  'get_teams': PermissionLevel.READ_ONLY,
  'list_commits': PermissionLevel.READ_ONLY,
  'list_issue_fields': PermissionLevel.READ_ONLY,
  'list_issue_types': PermissionLevel.READ_ONLY,
  'list_releases': PermissionLevel.READ_ONLY,
  'list_repository_collaborators': PermissionLevel.READ_ONLY,
  'list_tags': PermissionLevel.READ_ONLY,
  'search_users': PermissionLevel.READ_ONLY,
  'run_secret_scanning': PermissionLevel.READ_ONLY,
  'create_repository': PermissionLevel.MUTATING,
  'fork_repository': PermissionLevel.MUTATING,
  'request_copilot_review': PermissionLevel.MUTATING,
  'assign_copilot_to_issue': PermissionLevel.MUTATING,

  'list_workspaces': PermissionLevel.READ_ONLY,
  'select_workspace': PermissionLevel.MUTATING,
  'get_selected_workspace': PermissionLevel.READ_ONLY,
  'list_services': PermissionLevel.READ_ONLY,
  'get_service': PermissionLevel.READ_ONLY,
  'create_web_service': PermissionLevel.MUTATING,
  'create_static_site': PermissionLevel.MUTATING,
  'create_cron_job': PermissionLevel.MUTATING,
  'restart_service': PermissionLevel.MUTATING,
  'delete_service': PermissionLevel.MUTATING,
  'list_deploys': PermissionLevel.READ_ONLY,
  'get_deploy': PermissionLevel.READ_ONLY,
  'trigger_deploy': PermissionLevel.MUTATING,
  'cancel_deploy': PermissionLevel.MUTATING,
  'list_logs': PermissionLevel.READ_ONLY,
  'list_log_label_values': PermissionLevel.READ_ONLY,
  'get_metrics': PermissionLevel.READ_ONLY,
  'list_env_vars': PermissionLevel.READ_ONLY,
  'update_env_vars': PermissionLevel.MUTATING,
  'delete_env_var': PermissionLevel.MUTATING,
  'query_render_postgres': PermissionLevel.READ_ONLY,

  'sandbox_exec': PermissionLevel.MUTATING,
  'sandbox_run': PermissionLevel.MUTATING,
  'sandbox_install': PermissionLevel.MUTATING,
  'sandbox_ps': PermissionLevel.READ_ONLY,
  'sandbox_output': PermissionLevel.READ_ONLY,
  'sandbox_reset': PermissionLevel.MUTATING,
  'git_clone': PermissionLevel.MUTATING,
  'git_checkout': PermissionLevel.MUTATING,
  'git_pull': PermissionLevel.MUTATING,
  'git_status': PermissionLevel.READ_ONLY,
  'git_diff': PermissionLevel.READ_ONLY,
  'git_commit_push': PermissionLevel.MUTATING
};

const CLOSED_WORLD_TOOLS = new Set([
  'set_active_context', 'sandbox_status', 'sandbox_ps', 'sandbox_reset',
  'git_status', 'git_diff'
]);

export function getToolAnnotations(toolName: string) {
  const isReadOnly = TOOL_PERMISSIONS[toolName] === PermissionLevel.READ_ONLY;
  return {
    title: toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    readOnlyHint: isReadOnly,
    destructiveHint: !isReadOnly,
    idempotentHint: isReadOnly,
    openWorldHint: !CLOSED_WORLD_TOOLS.has(toolName)
  };
}

export type ToolCategory = 'core' | 'github_issues_prs' | 'github_admin' | 'render' | 'sandbox';

export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  set_active_context: 'core',
  get_me: 'core',
  get_file_contents: 'core',
  str_replace_editor: 'core',
  create_or_update_file: 'core',
  delete_file: 'core',
  grep: 'core',
  view_file_outline: 'core',
  list_branches: 'core',
  create_branch: 'core',
  delete_branch: 'core',
  push_files: 'core',
  create_pull_request: 'core',
  search_code: 'core',
  search_repositories: 'core',
  git_tree: 'core',
  patch_contents: 'core',
  sandbox_status: 'core',

  list_issues: 'github_issues_prs',
  list_pull_requests: 'github_issues_prs',
  issue_read: 'github_issues_prs',
  issue_write: 'github_issues_prs',
  sub_issue_write: 'github_issues_prs',
  add_issue_comment: 'github_issues_prs',
  pull_request_read: 'github_issues_prs',
  pull_request_review_write: 'github_issues_prs',
  add_comment_to_pending_review: 'github_issues_prs',
  add_reply_to_pull_request_comment: 'github_issues_prs',
  update_pull_request: 'github_issues_prs',
  update_pull_request_branch: 'github_issues_prs',
  merge_pull_request: 'github_issues_prs',
  search_issues: 'github_issues_prs',
  search_pull_requests: 'github_issues_prs',

  get_commit: 'github_admin',
  search_commits: 'github_admin',
  get_label: 'github_admin',
  get_release: 'github_admin',
  get_tag: 'github_admin',
  get_teams: 'github_admin',
  get_team_members: 'github_admin',
  list_commits: 'github_admin',
  list_releases: 'github_admin',
  list_tags: 'github_admin',
  list_issue_fields: 'github_admin',
  list_issue_types: 'github_admin',
  list_repository_collaborators: 'github_admin',
  search_users: 'github_admin',
  create_repository: 'github_admin',
  fork_repository: 'github_admin',
  run_secret_scanning: 'github_admin',
  request_copilot_review: 'github_admin',
  assign_copilot_to_issue: 'github_admin',

  list_workspaces: 'render',
  select_workspace: 'render',
  get_selected_workspace: 'render',
  list_services: 'render',
  get_service: 'render',
  create_web_service: 'render',
  create_static_site: 'render',
  create_cron_job: 'render',
  restart_service: 'render',
  delete_service: 'render',
  list_deploys: 'render',
  get_deploy: 'render',
  trigger_deploy: 'render',
  cancel_deploy: 'render',
  list_logs: 'render',
  list_log_label_values: 'render',
  get_metrics: 'render',
  list_env_vars: 'render',
  update_env_vars: 'render',
  delete_env_var: 'render',
  query_render_postgres: 'render',

  sandbox_exec: 'sandbox',
  sandbox_run: 'sandbox',
  sandbox_install: 'sandbox',
  sandbox_ps: 'sandbox',
  sandbox_reset: 'sandbox',
  git_clone: 'sandbox',
  git_checkout: 'sandbox',
  git_pull: 'sandbox',
  git_status: 'sandbox',
  git_diff: 'sandbox',
  git_commit_push: 'sandbox'
};

export function makeRegistrar(server: any, registry: Record<string, any>) {
  return (name: string, config: any, handler: any) => {
    registry[name] = server.registerTool(name, config, handler);
    return registry[name];
  };
}

export function compressResponseData(data: any, maxChars: number = 2500): any {
  if (data === null || data === undefined) return '';

  if (typeof data === 'string') {
    let clean = sanitizeOutput(data);
    if (clean.length > maxChars) {
      clean = clean.slice(0, maxChars) + `\n... [Truncated ${clean.length - maxChars} chars for token optimization]`;
    }
    return clean;
  }

  if (Array.isArray(data)) {
    const compressedList = data.slice(0, 15).map(item => compressResponseData(item, 300));
    let result: any[] = compressedList;
    if (data.length > 15) {
      result.push({ _meta: `Showing 15 of ${data.length} total entries.` });
    }
    return result;
  }

  if (typeof data === 'object') {
    const compressedObj: Record<string, any> = {};
    const keysToOmit = new Set(['node_id', 'gravatar_id', 'url', 'html_url', 'followers_url', 'following_url', 'gists_url', 'starred_url', 'subscriptions_url', 'organizations_url', 'repos_url', 'events_url', 'received_events_url', 'site_admin', 'authorizations_url']);

    for (const [key, value] of Object.entries(data)) {
      if (keysToOmit.has(key) || value === null || value === undefined || value === '') continue;
      compressedObj[key] = typeof value === 'object' ? compressResponseData(value, 500) : value;
    }
    return sanitizeOutput(compressedObj);
  }

  return data;
}

export function formatOptimizedResponse(data: any, maxChars?: number) {
  const compressed = compressResponseData(data, maxChars);
  const text = typeof compressed === 'string' ? compressed : JSON.stringify(compressed);
  return { content: [{ type: 'text' as const, text }] };
}

export function formatError(error: any) {
  const message = error?.message || String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${sanitizeOutput(message)}` }]
  };
}

export function sanitizeOutput(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data
      .replace(/(ghp_[a-zA-Z0-9]{36})/g, 'ghp_****')
      .replace(/(github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/g, 'github_pat_****')
      .replace(/(rnd_[a-zA-Z0-9]{24,32})/g, 'rnd_****')
      .replace(/(Bearer\s+)[a-zA-Z0-9._\-]+/gi, '$1[REDACTED]')
      .replace(/(x-api-key:\s*)[a-zA-Z0-9._\-]+/gi, '$1[REDACTED]')
      .replace(/-----BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY-----\n[\s\S]+?\n-----END \1 KEY-----/g, '[REDACTED_KEY]');
  }
  if (typeof data === 'object') {
    const copy: any = Array.isArray(data) ? [] : {};
    for (const key of Object.keys(data)) {
      const lower = key.toLowerCase();
      if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('apikey')) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = sanitizeOutput(data[key]);
      }
    }
    return copy;
  }
  return data;
}

export function sanitizePath(inputPath: string, rootDir: string = process.cwd()): string {
  const resolved = path.resolve(rootDir, inputPath);
  if (!resolved.startsWith(rootDir) && !resolved.startsWith('/tmp')) {
    throw new Error(`Security Violation: Path '${inputPath}' escapes sandbox boundary.`);
  }
  return resolved;
}

export function getNetworkRestrictionLevel(): 'low' | 'medium' | 'high' {
  const level = (process.env.NETWORK_RESTRICTION_LEVEL || 'low').toLowerCase();
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  return 'low';
}

export function getCommandRestrictionLevel(): 'low' | 'medium' | 'high' {
  const level = (process.env.COMMAND_RESTRICTION_LEVEL || 'low').toLowerCase();
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  return 'low';
}

export function sanitizeNetworkInCommand(cmd: string): void {
  const netLevel = getNetworkRestrictionLevel();

  const privateIpPatterns = [
    /169\.254\.169\.254/,
    /127\.0\.0\.1/,
    /0\.0\.0\.0/,
    /localhost/i,
    /::1/,
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}\b/,
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/
  ];

  for (const pattern of privateIpPatterns) {
    if (pattern.test(cmd)) {
      throw new Error(`Security Alert: Access to internal or private IP address blocked under ${netLevel.toUpperCase()} network restriction level.`);
    }
  }

  if (netLevel === 'medium') {
    const rawIpPattern = /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i;
    if (rawIpPattern.test(cmd)) {
      throw new Error('Security Alert: Direct IP address URLs blocked under MEDIUM network restriction level.');
    }
    const suspiciousSchemes = /(gopher|dict|file|ftp):\/\//i;
    if (suspiciousSchemes.test(cmd)) {
      throw new Error('Security Alert: Non-HTTP network protocol blocked under MEDIUM network restriction level.');
    }
  }

  if (netLevel === 'high') {
    const urls = cmd.match(/https?:\/\/([^\s\/:\'\"]+)/gi);
    if (urls) {
      const allowedDomains = [
        'github.com',
        'githubusercontent.com',
        'npmjs.org',
        'npmjs.com',
        'pypi.org',
        'pythonhosted.org',
        'render.com',
        'google.com',
        'googleapis.com',
        'cloudflare.com',
        'crates.io',
        'deno.land',
        'maven.org',
        'debian.org',
        'ubuntu.com'
      ];
      for (const rawUrl of urls) {
        const domainMatch = rawUrl.match(/https?:\/\/([^\s\/:\'\"]+)/i);
        if (domainMatch && domainMatch[1]) {
          const host = domainMatch[1].toLowerCase();
          const isAllowed = allowedDomains.some(d => host === d || host.endsWith('.' + d));
          if (!isAllowed) {
            throw new Error(`Security Alert: Domain '${host}' is blocked under HIGH network restriction level.`);
          }
        }
      }
    }
  }
}

export function sanitizeCommand(cmd: string): void {
  const cmdLevel = getCommandRestrictionLevel();
  const lowPatterns = [
    /rm\s+-rf\s+[\/]/i,
    /rm\s+-rf\s+\/\*/i,
    /mkfs/i,
    /dd\s+if=/i,
    />\s*\/dev\/sd/i,
    /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i
  ];
  const medPatterns = [
    ...lowPatterns,
    /shutdown/i,
    /reboot/i,
    /init\s+0/i,
    /chmod\s+-R\s+777\s+[\/]/i,
    /\/etc\/passwd/i,
    /\/etc\/shadow/i,
    /\/etc\/sudoers/i,
    /\/sbin\//i,
    /\/bin\/rm/i
  ];
  const highPatterns = [
    ...medPatterns,
    /\bsudo\b/i,
    /\bsu\b/i,
    /\bdoas\b/i,
    /\bnmap\b/i,
    /\bnc\s+-l/i,
    /\bnetcat\s+-l/i,
    /\bsocat\b/i,
    /\binsmod\b/i,
    /\bmodprobe\b/i,
    /\biptables\b/i
  ];

  const activePatterns = cmdLevel === 'high' ? highPatterns : (cmdLevel === 'medium' ? medPatterns : lowPatterns);
  for (const pattern of activePatterns) {
    if (pattern.test(cmd)) {
      throw new Error(`Security Alert: Command blocked under ${cmdLevel.toUpperCase()} command restriction level.`);
    }
  }

  sanitizeNetworkInCommand(cmd);
}

export function resolveInputString(plain?: string, b64?: string): string {
  if (b64) return Buffer.from(b64, 'base64').toString('utf-8');
  return plain || '';
}

export function safeRegexTest(pattern: string, flags: string, text: string, timeoutMs: number = 200): boolean {
  const context = { text, pattern, flags, result: false, error: null as any };
  try {
    const code = `
      try {
        const rx = new RegExp(pattern, flags);
        result = rx.test(text);
      } catch(e) {
        error = e;
      }
    `;
    vm.runInNewContext(code, context, { timeout: timeoutMs });
    if (context.error) throw context.error;
    return context.result;
  } catch (err: any) {
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error('Security Error: Regex matching timed out.');
    }
    throw err;
  }
}

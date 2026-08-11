import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSettings, loadToolPolicy, SecurityTier, isToolGloballyAllowed } from '../config/settings.js';

export enum PermissionLevel {
  READ_ONLY = 'READ_ONLY',
  MUTATING = 'MUTATING',
  ADMIN = 'ADMIN'
}

export type ToolCategory = 'core' | 'github_issues_prs' | 'github_admin' | 'render' | 'sandbox';

export interface SessionContext {
  owner?: string;
  repo?: string;
  branch?: string;
  workspaceId?: string;
  sandboxDir?: string;
  userId?: string;
  apiKeyHash?: string;
  securityTier: SecurityTier;
  enabledCategories: Set<ToolCategory>;
  enabledToolOverrides: Set<string>;
}

const sessionContexts = new Map<string, SessionContext>();

export function getSessionContext(sessionId: string): SessionContext {
  if (!sessionContexts.has(sessionId)) {
    const settings = loadSettings();
    const policy = loadToolPolicy();
    
    const defaultCats: ToolCategory[] = [];
    if (policy.policy?.defaultCategoryStatus) {
      for (const [cat, enabled] of Object.entries(policy.policy.defaultCategoryStatus)) {
        if (enabled) defaultCats.push(cat as ToolCategory);
      }
    }

    sessionContexts.set(sessionId, {
      securityTier: settings.security.currentTier,
      enabledCategories: new Set<ToolCategory>(defaultCats.length ? defaultCats : ['core']),
      enabledToolOverrides: new Set<string>()
    });
  }
  return sessionContexts.get(sessionId)!;
}

export function updateSessionContext(sessionId: string, updates: Partial<SessionContext>): SessionContext {
  const current = getSessionContext(sessionId);
  Object.assign(current, updates);
  return current;
}

export function deleteSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
}

export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  set_active_context: PermissionLevel.READ_ONLY,
  get_me: PermissionLevel.READ_ONLY,
  get_file_contents: PermissionLevel.READ_ONLY,
  str_replace_editor: PermissionLevel.MUTATING,
  create_or_update_file: PermissionLevel.MUTATING,
  delete_file: PermissionLevel.MUTATING,
  grep: PermissionLevel.READ_ONLY,
  view_file_outline: PermissionLevel.READ_ONLY,
  git_tree: PermissionLevel.READ_ONLY,
  patch_contents: PermissionLevel.MUTATING,
  list_branches: PermissionLevel.READ_ONLY,
  create_branch: PermissionLevel.MUTATING,
  delete_branch: PermissionLevel.MUTATING,
  push_files: PermissionLevel.MUTATING,
  create_pull_request: PermissionLevel.MUTATING,
  search_code: PermissionLevel.READ_ONLY,
  search_repositories: PermissionLevel.READ_ONLY,
  sandbox_status: PermissionLevel.READ_ONLY,
  load_toolset: PermissionLevel.READ_ONLY,

  list_issues: PermissionLevel.READ_ONLY,
  list_pull_requests: PermissionLevel.READ_ONLY,
  issue_read: PermissionLevel.READ_ONLY,
  issue_write: PermissionLevel.MUTATING,
  sub_issue_write: PermissionLevel.MUTATING,
  add_issue_comment: PermissionLevel.MUTATING,
  pull_request_read: PermissionLevel.READ_ONLY,
  pull_request_review_write: PermissionLevel.MUTATING,
  add_comment_to_pending_review: PermissionLevel.MUTATING,
  add_reply_to_pull_request_comment: PermissionLevel.MUTATING,
  update_pull_request: PermissionLevel.MUTATING,
  update_pull_request_branch: PermissionLevel.MUTATING,
  merge_pull_request: PermissionLevel.MUTATING,
  search_issues: PermissionLevel.READ_ONLY,
  search_pull_requests: PermissionLevel.READ_ONLY,

  get_commit: PermissionLevel.READ_ONLY,
  search_commits: PermissionLevel.READ_ONLY,
  get_label: PermissionLevel.READ_ONLY,
  get_release: PermissionLevel.READ_ONLY,
  get_tag: PermissionLevel.READ_ONLY,
  get_teams: PermissionLevel.READ_ONLY,
  get_team_members: PermissionLevel.READ_ONLY,
  list_commits: PermissionLevel.READ_ONLY,
  list_releases: PermissionLevel.READ_ONLY,
  list_tags: PermissionLevel.READ_ONLY,
  list_issue_fields: PermissionLevel.READ_ONLY,
  list_issue_types: PermissionLevel.READ_ONLY,
  list_repository_collaborators: PermissionLevel.READ_ONLY,
  search_users: PermissionLevel.READ_ONLY,
  create_repository: PermissionLevel.MUTATING,
  fork_repository: PermissionLevel.MUTATING,
  run_secret_scanning: PermissionLevel.READ_ONLY,
  request_copilot_review: PermissionLevel.MUTATING,
  assign_copilot_to_issue: PermissionLevel.MUTATING,

  list_workspaces: PermissionLevel.READ_ONLY,
  select_workspace: PermissionLevel.MUTATING,
  get_selected_workspace: PermissionLevel.READ_ONLY,
  list_services: PermissionLevel.READ_ONLY,
  get_service: PermissionLevel.READ_ONLY,
  create_web_service: PermissionLevel.MUTATING,
  create_static_site: PermissionLevel.MUTATING,
  create_cron_job: PermissionLevel.MUTATING,
  restart_service: PermissionLevel.MUTATING,
  delete_service: PermissionLevel.MUTATING,
  list_deploys: PermissionLevel.READ_ONLY,
  get_deploy: PermissionLevel.READ_ONLY,
  trigger_deploy: PermissionLevel.MUTATING,
  cancel_deploy: PermissionLevel.MUTATING,
  list_logs: PermissionLevel.READ_ONLY,
  list_log_label_values: PermissionLevel.READ_ONLY,
  get_metrics: PermissionLevel.READ_ONLY,
  list_env_vars: PermissionLevel.READ_ONLY,
  update_env_vars: PermissionLevel.MUTATING,
  delete_env_var: PermissionLevel.MUTATING,
  query_render_postgres: PermissionLevel.READ_ONLY,

  sandbox_run: PermissionLevel.MUTATING,
  sandbox_exec: PermissionLevel.MUTATING,
  sandbox_install: PermissionLevel.MUTATING,
  sandbox_ps: PermissionLevel.READ_ONLY,
  sandbox_reset: PermissionLevel.MUTATING,
  git_clone: PermissionLevel.MUTATING,
  git_checkout: PermissionLevel.MUTATING,
  git_pull: PermissionLevel.MUTATING,
  git_status: PermissionLevel.READ_ONLY,
  git_diff: PermissionLevel.READ_ONLY,
  git_commit_push: PermissionLevel.MUTATING
};

export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  set_active_context: 'core',
  get_me: 'core',
  get_file_contents: 'core',
  str_replace_editor: 'core',
  create_or_update_file: 'core',
  delete_file: 'core',
  grep: 'core',
  view_file_outline: 'core',
  git_tree: 'core',
  patch_contents: 'core',
  list_branches: 'core',
  create_branch: 'core',
  delete_branch: 'core',
  push_files: 'core',
  create_pull_request: 'core',
  search_code: 'core',
  search_repositories: 'core',
  sandbox_status: 'core',
  load_toolset: 'core',

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

  sandbox_run: 'sandbox',
  sandbox_exec: 'sandbox',
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

export function sanitizePath(inputPath: string, allowedRoot?: string): string {
  if (!inputPath) throw new Error("Path parameter cannot be empty.");
  const normalized = path.normalize(inputPath);
  if (normalized.includes('..') && (normalized.startsWith('../') || normalized.startsWith('..\\'))) {
    throw new Error(`Path traversal attempt blocked: '${inputPath}'`);
  }
  if (allowedRoot) {
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedTarget = path.resolve(allowedRoot, normalized);
    if (!resolvedTarget.startsWith(resolvedRoot)) {
      throw new Error(`Access denied: path '${inputPath}' escapes sandbox directory '${allowedRoot}'`);
    }
    return resolvedTarget;
  }
  return normalized;
}

export function sanitizeCommand(command: string, tier: SecurityTier = SecurityTier.STANDARD): string {
  if (!command || !command.trim()) throw new Error("Command cannot be empty.");
  const trimmed = command.trim();

  const standardPatterns = [
    /\brm\s+-[rf]{1,2}\s+(\/|~|\$HOME)\b/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    /\bdd\s+if=.*?of=\/dev\/(null|zero|sda|hda|nvme)\b/i,
    />\s*\/dev\/(sda|hda|nvme)/i,
    /\bmkfs(\.\w+)?\s+\/dev\//i
  ];

  for (const pat of standardPatterns) {
    if (pat.test(trimmed)) {
      throw new Error(`Dangerous command blocked by Krix Security Engine: '${trimmed}'`);
    }
  }

  if (tier === SecurityTier.STRICT || tier === SecurityTier.FORTRESS) {
    const strictPatterns = [
      /\b(sudo|su|doas)\b/i,
      /\bchmod\s+([0-7]{3,4}|\+[rwxXst]+)\s+(\/|~)/i,
      /\bchown\b/i,
      /\bkill\s+-9\s+1\b/i,
      /\bshutdown\b/i,
      /\breboot\b/i,
      /\binit\s+[06]\b/i
    ];
    for (const pat of strictPatterns) {
      if (pat.test(trimmed)) {
        throw new Error(`Command blocked under ${tier} security policy: '${trimmed}'`);
      }
    }
  }

  if (tier === SecurityTier.FORTRESS) {
    const mutatingPatterns = [
      /\b(apt|apt-get|yum|apk|dnf|pacman|brew)\s+install\b/i,
      /\b(curl|wget)\s+.*?\s*\|\s*(ba)?sh\b/i,
      /\bcurl\s+-O\b/i,
      /\bwget\b/i
    ];
    for (const pat of mutatingPatterns) {
      if (pat.test(trimmed)) {
        throw new Error(`Direct download/execution blocked under FORTRESS policy: '${trimmed}'`);
      }
    }
  }

  return trimmed;
}

export function sanitizeOutput(output: string): string {
  if (!output) return output;
  return output
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED_GITHUB_PAT]')
    .replace(/rnd_[A-Za-z0-9]{24,64}/g, '[REDACTED_RENDER_KEY]')
    .replace(/krix_live_[A-Za-z0-9_]{32,64}/g, '[REDACTED_KRIX_KEY]')
    .replace(/bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_+/=]*/gi, 'Bearer [REDACTED_JWT]')
    .replace(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

export function formatOptimizedResponse(data: any): { content: Array<{ type: 'text'; text: string }> } {
  let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  text = sanitizeOutput(text);
  return {
    content: [{
      type: 'text',
      text
    }]
  };
}

export function formatError(err: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const msg = err?.message || String(err);
  return {
    content: [{
      type: 'text',
      text: sanitizeOutput(`[Error]: ${msg}`)
    }],
    isError: true
  };
}

export function getToolAnnotations(toolName: string) {
  const perm = TOOL_PERMISSIONS[toolName] || PermissionLevel.READ_ONLY;
  return {
    readOnly: perm === PermissionLevel.READ_ONLY,
    destructive: perm === PermissionLevel.MUTATING || perm === PermissionLevel.ADMIN,
    category: TOOL_CATEGORY[toolName] || 'core'
  };
}

export function resolveInputString(input: string | undefined): string | undefined {
  if (!input) return input;
  return sanitizeOutput(input);
}

export interface ToggleableToolHandle {
  enable: () => void;
  disable: () => void;
  readonly enabled: boolean;
}

export function makeRegistrar(server: any, registry: Record<string, ToggleableToolHandle>) {
  return function register(
    name: string,
    config: any,
    handler: (args: any, extra?: any) => Promise<any>
  ) {
    if (!isToolGloballyAllowed(name)) {
      return;
    }

    const annotations = getToolAnnotations(name);
    config.annotations = {
      ...(config.annotations || {}),
      ...annotations
    };

    const handle = (server as any).registerTool(name, config, handler);
    if (handle && typeof handle.enable === 'function' && typeof handle.disable === 'function') {
      registry[name] = handle;
    }
  };
}

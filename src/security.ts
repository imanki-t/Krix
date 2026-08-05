import vm from 'node:vm';
import path from 'node:path';

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
}

const sessionContexts = new Map<string, SessionContext>();

export function getSessionContext(sessionId: string): SessionContext {
  if (!sessionContexts.has(sessionId)) {
    sessionContexts.set(sessionId, { branch: 'main' });
  }
  return sessionContexts.get(sessionId)!;
}

export function updateSessionContext(sessionId: string, patch: Partial<SessionContext>): SessionContext {
  const current = getSessionContext(sessionId);
  Object.assign(current, patch);
  return current;
}

export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  'set_active_context': PermissionLevel.READ_ONLY,
  'get_me': PermissionLevel.READ_ONLY,
  'get_file_contents': PermissionLevel.READ_ONLY,
  'get_commit': PermissionLevel.READ_ONLY,
  'get_label': PermissionLevel.READ_ONLY,
  'get_latest_release': PermissionLevel.READ_ONLY,
  'get_release_by_tag': PermissionLevel.READ_ONLY,
  'get_tag': PermissionLevel.READ_ONLY,
  'get_team_members': PermissionLevel.READ_ONLY,
  'get_teams': PermissionLevel.READ_ONLY,
  'list_branches': PermissionLevel.READ_ONLY,
  'list_commits': PermissionLevel.READ_ONLY,
  'list_issue_fields': PermissionLevel.READ_ONLY,
  'list_issue_types': PermissionLevel.READ_ONLY,
  'list_issues': PermissionLevel.READ_ONLY,
  'list_pull_requests': PermissionLevel.READ_ONLY,
  'list_releases': PermissionLevel.READ_ONLY,
  'list_repository_collaborators': PermissionLevel.READ_ONLY,
  'list_tags': PermissionLevel.READ_ONLY,
  'issue_read': PermissionLevel.READ_ONLY,
  'pull_request_read': PermissionLevel.READ_ONLY,
  'search_code': PermissionLevel.READ_ONLY,
  'search_commits': PermissionLevel.READ_ONLY,
  'search_issues': PermissionLevel.READ_ONLY,
  'search_pull_requests': PermissionLevel.READ_ONLY,
  'search_repositories': PermissionLevel.READ_ONLY,
  'search_users': PermissionLevel.READ_ONLY,
  'run_secret_scanning': PermissionLevel.READ_ONLY,
  'grep': PermissionLevel.READ_ONLY,
  'view_file_outline': PermissionLevel.READ_ONLY,

  'list_workspaces': PermissionLevel.READ_ONLY,
  'get_selected_workspace': PermissionLevel.READ_ONLY,
  'list_services': PermissionLevel.READ_ONLY,
  'get_service': PermissionLevel.READ_ONLY,
  'list_deploys': PermissionLevel.READ_ONLY,
  'get_deploy': PermissionLevel.READ_ONLY,
  'list_logs': PermissionLevel.READ_ONLY,
  'get_metrics': PermissionLevel.READ_ONLY,
  'list_env_vars': PermissionLevel.READ_ONLY,

  'get_sandbox_status': PermissionLevel.READ_ONLY,

  'add_comment_to_pending_review': PermissionLevel.MUTATING,
  'add_issue_comment': PermissionLevel.MUTATING,
  'add_reply_to_pull_request_comment': PermissionLevel.MUTATING,
  'create_branch': PermissionLevel.MUTATING,
  'create_or_update_file': PermissionLevel.MUTATING,
  'create_pull_request': PermissionLevel.MUTATING,
  'create_repository': PermissionLevel.MUTATING,
  'delete_file': PermissionLevel.MUTATING,
  'fork_repository': PermissionLevel.MUTATING,
  'issue_write': PermissionLevel.MUTATING,
  'merge_pull_request': PermissionLevel.MUTATING,
  'pull_request_review_write': PermissionLevel.MUTATING,
  'push_files': PermissionLevel.MUTATING,
  'request_copilot_review': PermissionLevel.MUTATING,
  'sub_issue_write': PermissionLevel.MUTATING,
  'update_pull_request': PermissionLevel.MUTATING,
  'update_pull_request_branch': PermissionLevel.MUTATING,
  'str_replace_editor': PermissionLevel.MUTATING,

  'select_workspace': PermissionLevel.MUTATING,
  'create_web_service': PermissionLevel.MUTATING,
  'create_static_site': PermissionLevel.MUTATING,
  'create_cron_job': PermissionLevel.MUTATING,
  'restart_service': PermissionLevel.MUTATING,
  'delete_service': PermissionLevel.MUTATING,
  'trigger_deploy': PermissionLevel.MUTATING,
  'cancel_deploy': PermissionLevel.MUTATING,
  'update_env_vars': PermissionLevel.MUTATING,
  'delete_env_var': PermissionLevel.MUTATING,
  'query_render_postgres': PermissionLevel.READ_ONLY,

  'execute_bash': PermissionLevel.MUTATING,
  'run_python': PermissionLevel.MUTATING,
  'run_node': PermissionLevel.MUTATING,
  'install_package': PermissionLevel.MUTATING,
  'run_code_file': PermissionLevel.MUTATING,
  'manage_process': PermissionLevel.MUTATING,
  'cleanup_sandbox': PermissionLevel.MUTATING
};

export function getToolAnnotations(toolName: string) {
  const isReadOnly = TOOL_PERMISSIONS[toolName] === PermissionLevel.READ_ONLY;
  return {
    readOnlyHint: isReadOnly,
    destructiveHint: !isReadOnly
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

export function formatOptimizedResponse(data: any) {
  const compressed = compressResponseData(data);
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
      .replace(/-----BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY-----[\s\S]+?-----END \1 KEY-----/g, '[REDACTED_KEY]');
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

export function sanitizeCommand(cmd: string): void {
  const dangerous = [/rm\s+-rf\s+[\/]/i, /mkfs/i, /dd\s+if=/i, />\s*\/dev\/sd/i, /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i];
  for (const pattern of dangerous) {
    if (pattern.test(cmd)) throw new Error('Security Alert: Command blocked due to safety policy.');
  }
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
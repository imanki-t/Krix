import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec, execSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations,
  sanitizeCommand, sanitizePath, getSessionContext, updateSessionContext, deleteSessionContext, makeRegistrar, getAuthKeyForSession
} from './security.js';

interface ActiveProcess {
  pid: number;
  command: string;
  proc: ChildProcess;
  startTime: Date;
  status: 'running' | 'exited';
  exitCode: number | null;
  exitedAt: Date | null;
  stdout: string;
  stderr: string;
}

const OUT_CAP = 100000;
const BG_BUF_CAP = 200000;
const EXEC_LIMITS = { maxBuffer: 4 * 1024 * 1024 };
const EXITED_TTL_MS = 10 * 60 * 1000;

const processTables = new Map<string, Map<number, ActiveProcess>>();
function procTable(sessionId: string): Map<number, ActiveProcess> {
  const key = getAuthKeyForSession(sessionId);
  let t = processTables.get(key);
  if (!t) { t = new Map(); processTables.set(key, t); }
  return t;
}

// Proactive safety net alongside the on-demand pruning in sandbox_ps: a
// caller who backgrounds jobs but never polls sandbox_ps would otherwise
// keep exited entries (and their buffered output) alive forever. Sweeps
// every identity's table on a timer regardless of whether anyone's asking.
const processTablePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const table of processTables.values()) {
    for (const [pid, item] of table) {
      if (item.status === 'exited' && item.exitedAt && now - item.exitedAt.getTime() > EXITED_TTL_MS) table.delete(pid);
    }
  }
}, 5 * 60 * 1000);
processTablePruneTimer.unref();

// Keeps only the most recent BG_BUF_CAP chars of a background process's
// output — bounds memory for long-running/chatty jobs instead of buffering
// unbounded stdout/stderr for the lifetime of the sandbox.
function appendCapped(buf: string, chunk: string, cap: number = BG_BUF_CAP): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function trunc(s: string, cap: number = OUT_CAP): string {
  const clean = s.trim();
  if (!clean) return '';
  return clean.length > cap ? `${clean.slice(0, cap)}\n…[+${clean.length - cap} chars truncated]` : clean;
}

// --- Paginated output cache -------------------------------------------
// trunc() alone drops anything past its cap with no way to retrieve it.
// truncWithCache() additionally stashes the full string (only when it was
// actually truncated) under a short-lived id, scoped per session so one
// session can never read another's cached output. sandbox_output serves
// paginated reads from this cache.
interface CachedOutput { content: string; createdAt: number; }
const outputCache = new Map<string, Map<string, CachedOutput>>();
const OUTPUT_CACHE_TTL_MS = 15 * 60 * 1000;
const OUTPUT_CACHE_MAX_PER_SESSION = 10;

function cacheOutput(sessionId: string, content: string): string {
  let bucket = outputCache.get(sessionId);
  if (!bucket) { bucket = new Map(); outputCache.set(sessionId, bucket); }
  if (bucket.size >= OUTPUT_CACHE_MAX_PER_SESSION) {
    const oldest = [...bucket.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) bucket.delete(oldest[0]);
  }
  const id = crypto.randomBytes(6).toString('hex');
  bucket.set(id, { content, createdAt: Date.now() });
  return id;
}

function getCachedOutput(sessionId: string, id: string): string | undefined {
  return outputCache.get(sessionId)?.get(id)?.content;
}

const outputCachePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, bucket] of outputCache) {
    for (const [id, entry] of bucket) {
      if (now - entry.createdAt > OUTPUT_CACHE_TTL_MS) bucket.delete(id);
    }
    if (bucket.size === 0) outputCache.delete(sid);
  }
}, 5 * 60 * 1000);
outputCachePruneTimer.unref();

function truncWithCache(sessionId: string, s: string, cap: number = OUT_CAP): string {
  const clean = s.trim();
  if (!clean) return '';
  if (clean.length <= cap) return clean;
  const id = cacheOutput(sessionId, clean);
  return `${clean.slice(0, cap)}\n…[+${clean.length - cap} chars truncated — call sandbox_output({ outputId: "${id}", offset: ${cap} }) to continue reading; cached 15min]`;
}

function execResponse(sessionId: string, err: any, stdout: string, stderr: string) {
  const out: Record<string, any> = {};
  const o = truncWithCache(sessionId, stdout || '');
  const e = truncWithCache(sessionId, stderr || '');
  if (o) out.stdout = o;
  if (e) out.stderr = e;
  if (err) out.exit = typeof err.code === 'number' ? err.code : 1;
  return formatOptimizedResponse(Object.keys(out).length ? out : { stdout: '(ok, no output)' });
}

function sandboxEnv(sessionId?: string): NodeJS.ProcessEnv {
  // process.env.HOME can point at a directory that doesn't exist in this
  // container (e.g. /home/sbx_userXXXX), which makes npm/pip fail with
  // ENOENT trying to create their cache/config dirs there. Pin HOME (and
  // the npm cache) to the sandbox's own writable tmp dir instead.
  const safeHome = path.join(os.tmpdir(), 'krix_home');
  try { require('node:fs').mkdirSync(safeHome, { recursive: true }); } catch {}
  const sessionEnv = sessionId ? (getSessionContext(sessionId).env || {}) : {};
  return {
    ...process.env,
    HOME: safeHome,
    npm_config_cache: path.join(safeHome, '.npm'),
    NODE_OPTIONS: sessionEnv.NODE_OPTIONS || '--max-old-space-size=400',
    ...sessionEnv,
  };
}

function run(cmd: string, cwd: string, timeout: number = 30000, sessionId?: string): Promise<{ err: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, env: sandboxEnv(sessionId), ...EXEC_LIMITS }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function sandboxRoot(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function workDir(sessionId: string): Promise<string> {
  const ctx = getSessionContext(sessionId);
  // A persisted default cwd (set via set_active_context) wins over the
  // cloned-repo/scratch-root default, but only if it still exists.
  if (ctx.cwd) {
    try { await fs.access(ctx.cwd); return ctx.cwd; } catch {}
  }
  if (ctx.sandboxDir) {
    try { await fs.access(ctx.sandboxDir); return ctx.sandboxDir; } catch {}
  }
  return sandboxRoot(sessionId);
}

// Resolves an optional user-supplied `dir` against the sandbox root (so
// callers can target the cloned repo, a scratch subfolder, or any other
// path within the sandbox — not just whatever workDir() currently returns),
// creating it if needed. Falls back to workDir() when no dir is given.
async function resolveDir(sessionId: string, dir?: string): Promise<string> {
  if (!dir) return workDir(sessionId);
  const root = await sandboxRoot(sessionId);
  const target = sanitizePath(dir, root);
  await fs.mkdir(target, { recursive: true });
  return target;
}

// --- Persistent shell sessions -------------------------------------------
// sandbox_exec previously spawned a brand-new process via exec() on every
// call, so `cd`, `export`, activating a venv, etc. never survived between
// calls — the dir/env args added some of that back, but not real shell
// state. This keeps one long-lived bash process alive per (identity,
// session) pair — see shellKey() below — and pipes commands into its
// stdin, reading output back out until a unique sentinel line appears.
// stdout+stderr are merged (`2>&1`) for the
// duration of each individual command only — bash redirections on a simple
// command don't persist past that command — which sidesteps a race between
// two separately-buffered pipes with no reliable way to know both streams
// are done at the same moment.
interface PersistentShell { proc: ChildProcess; buf: string; busy: boolean; }
const persistentShells = new Map<string, PersistentShell>();
const SHELL_HANG_MS = 60000;

// Shell identity: authKey scopes it to the user (so one user's shell can
// never be reached or torn down by another user), sessionId further scopes
// it to a single session of that user (so concurrent sessions/tabs of the
// SAME user each get their own shell instead of contending for one, and so
// one session's idle-timeout/disconnect can't kill a shell another of that
// user's sessions is still using). The sandbox filesystem is intentionally
// still shared per-authKey (see sandboxRoot) — only the live shell process
// is session-scoped.
function shellKey(sessionId: string): string {
  return `${getAuthKeyForSession(sessionId)}::${sessionId}`;
}

// Guards shell creation against a race: getShell awaits workDir() before it
// registers the new shell, so two concurrent calls for the same key
// (no shell running yet) can both pass the `existing` check, both spawn a
// bash process, and the second persistentShells.set() silently overwrites
// the first — orphaning a live, untracked child process. Callers that land
// mid-creation await the same in-flight promise instead of racing to spawn
// their own.
const shellCreation = new Map<string, Promise<PersistentShell>>();

async function getShell(sessionId: string): Promise<PersistentShell> {
  const key = shellKey(sessionId);
  const existing = persistentShells.get(key);
  if (existing && !existing.proc.killed) return existing;

  const inFlight = shellCreation.get(key);
  if (inFlight) return inFlight;

  const creation = (async () => {
    const cwd = await workDir(sessionId);
    const proc = spawn('bash', ['--noprofile', '--norc'], { cwd, env: sandboxEnv(sessionId) });
    const shell: PersistentShell = { proc, buf: '', busy: false };
    proc.stdout?.on('data', (d) => { shell.buf += d.toString(); });
    proc.on('exit', () => { if (persistentShells.get(key) === shell) persistentShells.delete(key); });
    persistentShells.set(key, shell);
    return shell;
  })();
  shellCreation.set(key, creation);
  try {
    return await creation;
  } finally {
    shellCreation.delete(key);
  }
}

function killShell(key: string): void {
  const shell = persistentShells.get(key);
  if (shell) { try { shell.proc.kill('SIGKILL'); } catch {} persistentShells.delete(key); }
}

async function runInShell(sessionId: string, command: string, timeoutMs: number): Promise<{ stdout: string; exit: number; timedOut: boolean }> {
  const shell = await getShell(sessionId);
  if (shell.busy) throw new Error('A previous command is still running in this persistent shell — wait for it to finish, or use background:true for long-running commands.');

  shell.busy = true;
  shell.buf = '';
  const marker = `__KRIX_DONE_${crypto.randomBytes(6).toString('hex')}__`;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // We don't know what state the shell is in (mid-command, hung on
      // input, etc.), so don't try to reuse it — kill it and let the next
      // call spawn a fresh one. Only this session's shell is affected.
      killShell(shellKey(sessionId));
      resolve({ stdout: shell.buf, exit: -1, timedOut: true });
    }, timeoutMs);

    const check = () => {
      const idx = shell.buf.indexOf(marker);
      if (idx === -1) return;
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      shell.proc.stdout?.removeListener('data', check);
      const before = shell.buf.slice(0, idx);
      const afterMarker = shell.buf.slice(idx + marker.length);
      const codeMatch = afterMarker.match(/^:(-?\d+)/);
      const exit = codeMatch ? parseInt(codeMatch[1], 10) : 0;
      shell.busy = false;
      resolve({ stdout: before.replace(/\n$/, ''), exit, timedOut: false });
    };

    shell.proc.stdout?.on('data', check);
    shell.proc.stdin?.write(`${command} 2>&1\necho "${marker}:$?"\n`);
    // In case the marker arrived in the same tick data already buffered.
    check();
  });
}
// ---------------------------------------------------------------------------

export async function destroySandbox(sessionId: string, options: { deleteContext?: boolean } = { deleteContext: true }): Promise<void> {
  // Capture the auth key BEFORE deleting session context — deleteSessionContext()
  // removes the sessionId->authKey mapping, after which getAuthKeyForSession()
  // falls back to 'anonymous', which would target the wrong (nonexistent)
  // scratch directory and the wrong (empty) process table, leaving the real
  // ones untouched.
  const authKey = getAuthKeyForSession(sessionId);
  const dirToRemove = path.join(os.tmpdir(), `krix_sbx_${authKey}`);
  const shellToKill = shellKey(sessionId);
  if (options.deleteContext) {
    deleteSessionContext(sessionId);
  }
  killShell(shellToKill);
  outputCache.delete(sessionId);
  const table = processTables.get(authKey);
  if (table) {
    for (const [, item] of table) { try { item.proc.kill('SIGKILL'); } catch {} }
    processTables.delete(authKey);
  }
  try {
    await fs.rm(dirToRemove, { recursive: true, force: true });
  } catch {}
}

function fileRunCmd(ext: string, abs: string, extraArgs: string, binPath?: string): string {
  switch (ext) {
    case '.py': return `python3 "${abs}" ${extraArgs}`;
    case '.js': return `node "${abs}" ${extraArgs}`;
    case '.ts': return `npx -y tsx "${abs}" ${extraArgs}`;
    case '.sh': return `bash "${abs}" ${extraArgs}`;
    case '.go': return `go run "${abs}" ${extraArgs}`;
    case '.java': return `java "${abs}" ${extraArgs}`;
    case '.cpp': {
      const bin = binPath || path.join(path.dirname(abs), `_sbx_out_${Date.now()}`);
      return `g++ "${abs}" -o "${bin}" && "${bin}" ${extraArgs}`;
    }
    case '.c': {
      const bin = binPath || path.join(path.dirname(abs), `_sbx_out_${Date.now()}`);
      return `gcc "${abs}" -o "${bin}" && "${bin}" ${extraArgs}`;
    }
    case '.rs': {
      const bin = binPath || path.join(path.dirname(abs), `_sbx_out_${Date.now()}`);
      return `rustc -O "${abs}" -o "${bin}" && "${bin}" ${extraArgs}`;
    }
    case '.rb': return `ruby "${abs}" ${extraArgs}`;
    case '.php': return `php "${abs}" ${extraArgs}`;
    default: throw new Error(`Unsupported extension '${ext}'. Use py/js/ts/sh/go/java/cpp/c/rust/ruby/php.`);
  }
}

const EXT_BY_LANG: Record<string, string> = { py: '.py', js: '.js', ts: '.ts', sh: '.sh', go: '.go', java: '.java', cpp: '.cpp', c: '.c', rust: '.rs', ruby: '.rb', php: '.php' };
const COMPILED_EXTS = new Set(['.cpp', '.c', '.rs']);

function authFlag(token?: string): string {
  if (!token) return '';
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `-c http.extraHeader="Authorization: Basic ${b64}" `;
}

export function registerSandboxTools(server: McpServer, sessionId: string, githubToken: string | undefined, registry: Record<string, any>) {
  const reg = makeRegistrar(server, registry);

  reg('sandbox_exec', {
    description: 'Run a shell command. By default runs in a persistent shell that keeps cd/export/venv state across calls (like a real terminal) — pass `persistent:false` for an isolated one-off exec instead. Pass `dir` to target any sandbox path (one-off cd for that call only). Pass `background:true` to run detached and track it via sandbox_ps (always isolated, unaffected by `persistent`).',
    inputSchema: {
      command: z.string(),
      timeoutMs: z.number().optional(),
      dir: z.string().optional(),
      background: z.boolean().optional().default(false),
      persistent: z.boolean().optional().default(true)
    },
    annotations: getToolAnnotations('sandbox_exec')
  }, async (args: any) => {
    try {
      sanitizeCommand(args.command);
      const cwd = await resolveDir(sessionId, args.dir);

      if (args.background) {
        const proc = spawn(args.command, { cwd, shell: true, env: sandboxEnv(sessionId) });
        if (!proc.pid) throw new Error('Failed to start background process.');
        const pid = proc.pid;
        const entry: ActiveProcess = { pid, command: args.command, proc, startTime: new Date(), status: 'running', exitCode: null, exitedAt: null, stdout: '', stderr: '' };
        procTable(sessionId).set(pid, entry);
        proc.stdout?.on('data', (d) => { entry.stdout = appendCapped(entry.stdout, d.toString()); });
        proc.stderr?.on('data', (d) => { entry.stderr = appendCapped(entry.stderr, d.toString()); });
        proc.on('exit', (code) => { entry.status = 'exited'; entry.exitCode = code; entry.exitedAt = new Date(); });
        return formatOptimizedResponse({ started: pid, command: args.command, dir: cwd });
      }

      const timeoutMs = Math.min(args.timeoutMs || 30000, 120000);

      if (args.persistent) {
        // `dir` (if given) only cd's for this one command — it doesn't
        // change the persistent shell's real cwd for future calls, same as
        // a subshell cd would behave.
        const cmd = args.dir ? `cd "${cwd}" && ${args.command}` : args.command;
        const { stdout, exit, timedOut } = await runInShell(sessionId, cmd, Math.min(timeoutMs, SHELL_HANG_MS));
        if (timedOut) return formatError(`Command timed out after ${timeoutMs}ms and the persistent shell was restarted (its prior state is lost). Use background:true for long-running commands instead.`);
        const out: Record<string, any> = {};
        const o = truncWithCache(sessionId, stdout);
        if (o) out.stdout = o;
        if (exit !== 0) out.exit = exit;
        return formatOptimizedResponse(Object.keys(out).length ? out : { stdout: '(ok, no output)' });
      }

      const { err, stdout, stderr } = await run(args.command, cwd, timeoutMs, sessionId);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_run', {
    description: 'Run code: pass inline `code` (+ optional `lang`, default py) or an existing `filePath`. Langs: py,js,ts,sh,go,java,cpp,c,rust,ruby,php. Pass `dir` to run in any sandbox directory instead of the default workDir.',
    inputSchema: {
      lang: z.enum(['py', 'js', 'ts', 'sh', 'go', 'java', 'cpp', 'c', 'rust', 'ruby', 'php']).optional(),
      code: z.string().optional(),
      filePath: z.string().optional(),
      args: z.array(z.string()).optional(),
      dir: z.string().optional()
    },
    annotations: getToolAnnotations('sandbox_run')
  }, async (args: any) => {
    let tmp: string | null = null;
    let createdBin: string | null = null;
    try {
      const cwd = await resolveDir(sessionId, args.dir);
      const extraArgs = (args.args || []).join(' ');

      let cmd: string;
      if (args.filePath) {
        const abs = sanitizePath(args.filePath, cwd);
        const ext = path.extname(abs).toLowerCase();
        if (COMPILED_EXTS.has(ext)) {
          createdBin = path.join(cwd, `_sbx_out_${Date.now()}`);
          cmd = fileRunCmd(ext, abs, extraArgs, createdBin);
        } else {
          cmd = fileRunCmd(ext, abs, extraArgs);
        }
      } else if (args.code) {
        const ext = EXT_BY_LANG[args.lang || 'py'] || '.py';
        tmp = path.join(cwd, `_snippet_${Date.now()}${ext}`);
        await fs.writeFile(tmp, args.code, 'utf-8');
        if (COMPILED_EXTS.has(ext)) {
          createdBin = path.join(cwd, `_sbx_out_${Date.now()}`);
          cmd = fileRunCmd(ext, tmp, extraArgs, createdBin);
        } else {
          cmd = fileRunCmd(ext, tmp, extraArgs);
        }
      } else {
        throw new Error('Provide either `code` or `filePath`.');
      }

      const { err, stdout, stderr } = await run(cmd, cwd, 45000, sessionId);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
    finally {
      if (tmp) await fs.unlink(tmp).catch(() => {});
      if (createdBin) await fs.unlink(createdBin).catch(() => {});
    }
  });

  reg('sandbox_install', {
    description: 'Install npm or pip packages. Defaults to the isolated sandbox root (never the cloned repo, so it can\'t pollute git-tracked files) — pass `dir` to target a specific directory instead.',
    inputSchema: { manager: z.enum(['npm', 'pip']), packages: z.array(z.string()).min(1), dir: z.string().optional() },
    annotations: getToolAnnotations('sandbox_install')
  }, async (args: any) => {
    try {
      // Default (no dir given) is the auth-scoped root, not workDir() —
      // workDir() returns the cloned repo's directory once one exists, and
      // installing there modified the repo's real package.json/
      // package-lock.json or dumped raw pip package files into the git
      // working tree. Pass `dir` explicitly if you really want that.
      const cwd = args.dir ? await resolveDir(sessionId, args.dir) : await sandboxRoot(sessionId);
      const list = args.packages.join(' ');
      const cmd = args.manager === 'npm' ? `npm install ${list}` : `pip install --quiet --target=. ${list}`;
      const { err, stdout, stderr } = await run(cmd, cwd, 90000, sessionId);
      if (err) return execResponse(sessionId, err, stdout, stderr);
      return formatOptimizedResponse({ installed: args.packages, path: cwd });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_ps', {
    description: 'List, kill (pid or "all"), or fetch output of background sandbox processes started via sandbox_exec(background:true). `offset`/`limit` paginate action:list (by item) and action:output (by char).',
    inputSchema: {
      action: z.enum(['list', 'kill', 'output']).default('list'),
      pid: z.union([z.coerce.number(), z.literal('all')]).optional(),
      offset: z.number().optional().describe('Pagination offset — item index for action:list, char offset for action:output.'),
      limit: z.number().optional().describe(`Page size — max 200 items for action:list, max ${OUT_CAP} chars for action:output.`)
    },
    annotations: getToolAnnotations('sandbox_ps')
  }, async (args: any) => {
    const table = procTable(sessionId);

    // Prune old exited entries so the table doesn't grow unbounded across
    // many background runs — running processes are never pruned.
    const now = Date.now();
    for (const [pid, item] of table) {
      if (item.status === 'exited' && item.exitedAt && now - item.exitedAt.getTime() > EXITED_TTL_MS) table.delete(pid);
    }

    if (args.action === 'kill') {
      if (args.pid === 'all') {
        const killed: number[] = [];
        for (const [pid, item] of table) {
          if (item.status === 'running') { try { item.proc.kill('SIGKILL'); } catch {} }
          killed.push(pid);
          table.delete(pid);
        }
        return formatOptimizedResponse({ killed });
      }
      if (!args.pid) return formatError('Provide `pid` (a number or "all") for kill.');
      const item = table.get(args.pid);
      if (!item) return formatError('No such process.');
      try { item.proc.kill('SIGKILL'); } catch {}
      table.delete(args.pid);
      return formatOptimizedResponse({ killed: args.pid });
    }

    if (args.action === 'output') {
      if (!args.pid || args.pid === 'all') return formatError('Provide a specific numeric `pid` for output.');
      const item = table.get(args.pid);
      if (!item) return formatError('No such process.');
      const offset = Math.max(0, args.offset || 0);
      const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
      const out: Record<string, any> = { pid: item.pid, status: item.status, exitCode: item.exitCode, stdoutLength: item.stdout.length, stderrLength: item.stderr.length };
      const stdoutSlice = item.stdout.slice(offset, offset + limit);
      const stderrSlice = item.stderr.slice(offset, offset + limit);
      if (stdoutSlice) out.stdout = stdoutSlice;
      if (stderrSlice) out.stderr = stderrSlice;
      if (offset + limit < Math.max(item.stdout.length, item.stderr.length)) out.nextOffset = offset + limit;
      return formatOptimizedResponse(out);
    }

    const all = Array.from(table.values()).map(p => ({
      pid: p.pid, command: p.command, status: p.status, exitCode: p.exitCode
    }));
    if (!all.length) return formatOptimizedResponse('No active processes.');
    const offset = Math.max(0, args.offset || 0);
    const limit = Math.min(args.limit || 50, 200);
    const page = all.slice(offset, offset + limit);
    const out: Record<string, any> = { processes: page, total: all.length, offset };
    if (offset + page.length < all.length) out.nextOffset = offset + page.length;
    return formatOptimizedResponse(out);
  });

  reg('sandbox_output', {
    description: 'Page through output that was truncated by sandbox_exec/sandbox_run/sandbox_install — use the outputId from the truncation notice. Cached per-session for 15 minutes (10 most recent truncated outputs kept; older ones are evicted).',
    inputSchema: {
      outputId: z.string(),
      offset: z.number().optional().default(0).describe('Char offset to resume from — defaults to 0, but the truncation notice tells you where the first response left off.'),
      limit: z.number().optional().describe(`Max chars to return (default/cap: ${OUT_CAP}).`)
    },
    annotations: getToolAnnotations('sandbox_output')
  }, async (args: any) => {
    try {
      const full = getCachedOutput(sessionId, args.outputId);
      if (full === undefined) return formatError('No cached output for that outputId — it may have expired (15min TTL) or been evicted (only the 10 most recent truncated outputs per session are kept).');
      const offset = Math.max(0, args.offset || 0);
      const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
      const slice = full.slice(offset, offset + limit);
      const out: Record<string, any> = { content: slice, offset, totalLength: full.length };
      if (offset + slice.length < full.length) out.nextOffset = offset + slice.length;
      return formatOptimizedResponse(out);
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_file', {
    description: 'Read, write, append to, edit (find-and-replace via old_str/new_str), or delete a file in the sandbox — safer than shell-escaping content through sandbox_exec. For edit, old_str can be any length — a single line or an entire block — as long as it matches the file exactly once; it is not limited to short snippets.',
    inputSchema: {
      action: z.enum(['read', 'write', 'append', 'edit', 'delete']),
      path: z.string(),
      content: z.string().optional(),
      old_str: z.string().optional().describe('Required for action:edit. Must match the file content in exactly one place.'),
      new_str: z.string().optional().describe('Required for action:edit. Replaces old_str; empty string deletes the matched text.'),
      dir: z.string().optional(),
      offset: z.number().optional().describe('For action:read — char offset to start from, for paginating large files.'),
      limit: z.number().optional().describe(`For action:read — max chars to return (default/cap: ${OUT_CAP}).`)
    },
    annotations: getToolAnnotations('sandbox_file')
  }, async (args: any) => {
    try {
      const base = await resolveDir(sessionId, args.dir);
      const abs = sanitizePath(args.path, base);

      if (args.action === 'read') {
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) return formatError(`No such file: ${args.path}`);
        const content = await fs.readFile(abs, 'utf-8');
        const offset = Math.max(0, args.offset || 0);
        const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
        const slice = content.slice(offset, offset + limit);
        const out: Record<string, any> = { sizeBytes: stat.size, totalChars: content.length, offset };
        if (slice) out.content = slice;
        if (offset + slice.length < content.length) out.nextOffset = offset + slice.length;
        return formatOptimizedResponse(out);
      }

      if (args.action === 'delete') {
        await fs.unlink(abs);
        return formatOptimizedResponse({ deleted: args.path });
      }

      if (args.action === 'edit') {
        if (args.old_str === undefined || args.new_str === undefined) return formatError('`old_str` and `new_str` are both required for action:edit.');
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) return formatError(`No such file: ${args.path}`);
        const content = await fs.readFile(abs, 'utf-8');
        const count = content.split(args.old_str).length - 1;
        if (count === 0) return formatError('old_str not found in file.');
        if (count > 1) return formatError(`old_str matches ${count} places — make it unique by including more surrounding context.`);
        const idx = content.indexOf(args.old_str);
        const updated = content.slice(0, idx) + args.new_str + content.slice(idx + args.old_str.length);
        await fs.writeFile(abs, updated, 'utf-8');
        const newStat = await fs.stat(abs);
        return formatOptimizedResponse({ edited: args.path, sizeBytes: newStat.size });
      }

      if (args.content === undefined) return formatError('`content` is required for write/append.');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (args.action === 'append') await fs.appendFile(abs, args.content, 'utf-8');
      else await fs.writeFile(abs, args.content, 'utf-8');
      const stat = await fs.stat(abs);
      return formatOptimizedResponse({ [args.action === 'append' ? 'appended' : 'wrote']: args.path, sizeBytes: stat.size });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_reset', {
    description: 'Wipe the sandbox: scratch files, cloned repo, persistent shell, and background processes.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_reset')
  }, async () => {
    try {
      await destroySandbox(sessionId, { deleteContext: false });
      updateSessionContext(sessionId, { sandboxDir: undefined });
      return formatOptimizedResponse({ reset: true });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_status', {
    description: 'Check available runtimes, memory, and the active repo/branch.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_status')
  }, async () => {
    try {
      const runtimes: Record<string, string> = {};
      const check = (name: string, cmd: string) => {
        try { runtimes[name] = execSync(cmd, { timeout: 1000 }).toString().trim(); }
        catch { runtimes[name] = 'N/A'; }
      };
      check('node', 'node -v');
      check('python', 'python3 --version');
      check('git', 'git --version');
      check('go', 'go version');

      const ctx = getSessionContext(sessionId);
      let cloned = false;
      if (ctx.sandboxDir) {
        try { await fs.access(ctx.sandboxDir); cloned = true; }
        catch { updateSessionContext(sessionId, { sandboxDir: undefined }); }
      }
      return formatOptimizedResponse({
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        runtimes,
        repo: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : undefined,
        branch: ctx.branch,
        cloned,
        cwd: ctx.cwd,
        envVars: ctx.env ? Object.keys(ctx.env).length : undefined,
        persistentShellAlive: !!persistentShells.get(shellKey(sessionId))
      });
    } catch (err) { return formatError(err); }
  });

  reg('git_clone', {
    description: 'Clone a repo into the sandbox so it can be run/tested. Omit owner/repo to use active set_active_context.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string().optional(), depth: z.number().optional().default(1) },
    annotations: getToolAnnotations('git_clone')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      const owner = args.owner || ctx.owner;
      const repo = args.repo || ctx.repo;
      if (!owner || !repo) throw new Error('owner/repo missing. Pass them or call set_active_context first.');
      const branch = args.branch || ctx.branch || 'main';

      const root = await sandboxRoot(sessionId);
      const dest = path.join(root, repo);
      try {
        await fs.access(dest);
        updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
        return formatOptimizedResponse({ note: 'already cloned', path: dest });
      } catch {}

      const url = `https://github.com/${owner}/${repo}.git`;
      const cmd = `git ${authFlag(githubToken)}clone --depth ${args.depth || 1} --branch ${branch} --single-branch "${url}" "${dest}"`;
      const { err, stdout, stderr } = await run(cmd, root, 60000);
      if (err) return execResponse(sessionId, err, stdout, stderr);

      await run(`git config user.email "agent@sandbox.local" && git config user.name "Sandbox Agent"`, dest);
      updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
      return formatOptimizedResponse({ cloned: `${owner}/${repo}`, branch, path: dest });
    } catch (err) { return formatError(err); }
  });

  reg('git_checkout', {
    description: 'Switch or create a branch in the active cloned repo.',
    inputSchema: { branch: z.string(), create: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('git_checkout')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const cmd = `git checkout ${args.create ? '-b ' : ''}${args.branch}`;
      const { err, stdout, stderr } = await run(cmd, ctx.sandboxDir, 15000);
      if (err) return execResponse(sessionId, err, stdout, stderr);
      updateSessionContext(sessionId, { branch: args.branch });
      return formatOptimizedResponse({ branch: args.branch });
    } catch (err) { return formatError(err); }
  });

  reg('git_pull', {
    description: 'Fast-forward pull the active branch of the cloned repo.',
    inputSchema: {},
    annotations: getToolAnnotations('git_pull')
  }, async () => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const cmd = `git ${authFlag(githubToken)}pull --ff-only`;
      const { err, stdout, stderr } = await run(cmd, ctx.sandboxDir, 30000);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('git_status', {
    description: 'Compact status (branch + changed files) of the cloned repo.',
    inputSchema: {},
    annotations: getToolAnnotations('git_status')
  }, async () => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const { err, stdout, stderr } = await run('git status --porcelain=v1 -b', ctx.sandboxDir, 10000);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('git_diff', {
    description: 'Diff of the cloned repo, optionally scoped to a path or staged changes.',
    inputSchema: { path: z.string().optional(), staged: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('git_diff')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const cmd = `git diff ${args.staged ? '--cached ' : ''}-- ${args.path ? `"${args.path}"` : ''}`;
      const { err, stdout, stderr } = await run(cmd, ctx.sandboxDir, 10000);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('git_commit_push', {
    description: 'Stage, commit, and (by default) push changes in the cloned repo.',
    inputSchema: { message: z.string(), push: z.boolean().optional().default(true) },
    annotations: getToolAnnotations('git_commit_push')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const branch = ctx.branch || 'main';

      const add = await run('git add -A', ctx.sandboxDir, 10000);
      if (add.err) return execResponse(sessionId, add.err, add.stdout, add.stderr);

      const commit = await run(`git commit -m ${JSON.stringify(args.message)}`, ctx.sandboxDir, 10000);
      if (commit.err) return execResponse(sessionId, commit.err, commit.stdout, commit.stderr);

      if (!args.push) return formatOptimizedResponse({ committed: true });

      const push = await run(`git ${authFlag(githubToken)}push -u origin ${branch}`, ctx.sandboxDir, 30000);
      if (push.err) return execResponse(sessionId, push.err, push.stdout, push.stderr);
      return formatOptimizedResponse({ committed: true, pushed: branch });
    } catch (err) { return formatError(err); }
  });
}

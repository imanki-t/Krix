import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec, execFile, execSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations,
  sanitizeCommand, sanitizePath, sanitizeExistingPath, sanitizeWritablePath, getSessionContext, updateSessionContext, deleteSessionContext, makeRegistrar, getAuthKeyForSession
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
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BG_BUF_CAP = 200000;
const EXEC_LIMITS = { maxBuffer: 4 * 1024 * 1024 };
const EXITED_TTL_MS = 10 * 60 * 1000;
const MAX_BACKGROUND_PROCESSES = 8;
const MAX_BACKGROUND_LIFETIME_MS = 30 * 60 * 1000;

const processTables = new Map<string, Map<number, ActiveProcess>>();
function procTable(sessionId: string): Map<number, ActiveProcess> {
  const key = sessionId;
  let t = processTables.get(key);
  if (!t) { t = new Map(); processTables.set(key, t); }
  return t;
}

const processTablePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const table of processTables.values()) {
    for (const [pid, item] of table) {
      if (item.status === 'running' && now - item.startTime.getTime() > MAX_BACKGROUND_LIFETIME_MS) { try { item.proc.kill('SIGKILL'); } catch {} }
      if (item.status === 'exited' && item.exitedAt && now - item.exitedAt.getTime() > EXITED_TTL_MS) table.delete(pid);
    }
  }
}, 5 * 60 * 1000);
processTablePruneTimer.unref();

function appendCapped(buf: string, chunk: string, cap: number = BG_BUF_CAP): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function trunc(s: string, cap: number = OUT_CAP): string {
  const clean = s.trim();
  if (!clean) return '';
  return clean.length > cap ? `${clean.slice(0, cap)}\n…[+${clean.length - cap} chars truncated]` : clean;
}

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

function sandboxEnv(sessionId?: string): Record<string, string> {
  const root = sessionId ? path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`) : path.join(os.tmpdir(), 'krix_sbx');
  const safeHome = path.join(root, '.home');
  const sessionEnv = sessionId ? (getSessionContext(sessionId).env || {}) : {};
  const clean: NodeJS.ProcessEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: safeHome,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    npm_config_cache: path.join(safeHome, '.npm'),
    GIT_TERMINAL_PROMPT: '0'
  };
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) continue;
    if (/^(PATH|HOME|TMPDIR|LD_|NODE_OPTIONS|BASH_ENV|ENV|GIT_.*|NPM_CONFIG_.*)$/i.test(key)) continue;
    if (typeof value === 'string' && value.length <= 8192) clean[key] = value;
  }
  return clean;
}

function sandboxMode(): 'bwrap' | 'host' | 'disabled' {
  const mode = (process.env.SANDBOX_MODE || 'disabled').toLowerCase();
  if (mode === 'bwrap') return mode;
  if (mode === 'host' && process.env.ALLOW_UNSAFE_HOST_SANDBOX === 'true') return mode;
  if (mode === 'disabled') return mode;
  return 'disabled';
}

function bwrapArgs(sessionId: string, cwd: string, command: string, network = false): string[] {
  const root = path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
  const env = sandboxEnv(sessionId);
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/usr/local', '/usr/local',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--bind', root, root,
    '--dir', '/home', '--dir', '/root',
    '--chdir', cwd,
  ];
  if (network) args.push('--share-net');
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  if (command) args.push('/bin/bash', '--noprofile', '--norc', '-lc', command);
  else args.push('/bin/bash', '--noprofile', '--norc');
  return args;
}


function run(cmd: string, cwd: string, timeout: number = 30000, sessionId?: string, network = false): Promise<{ err: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const mode = sandboxMode();
    if (mode === 'disabled') { resolve({ err: Object.assign(new Error('Sandbox is disabled in production configuration.'), { code: 126 }), stdout: '', stderr: 'Sandbox disabled.' }); return; }
    if (!sessionId) { resolve({ err: Object.assign(new Error('Sandbox session missing.'), { code: 126 }), stdout: '', stderr: 'Sandbox session missing.' }); return; }
    const env = sandboxEnv(sessionId);
    if (mode === 'host') {
      exec(cmd, { cwd, timeout, env, maxBuffer: 4 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      return;
    }
    const args = bwrapArgs(sessionId, cwd, cmd, network);
    execFile('bwrap', args, { cwd: '/', timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function sandboxRoot(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dir, '.home'), { recursive: true, mode: 0o700 });
  return dir;
}

async function workDir(sessionId: string): Promise<string> {
  const ctx = getSessionContext(sessionId);
  if (ctx.cwd) {
    try {
      const root = await sandboxRoot(sessionId);
      const safe = await sanitizeExistingPath(ctx.cwd, root);
      return safe;
    } catch {}
  }
  if (ctx.sandboxDir) {
    try { await fs.access(ctx.sandboxDir); return ctx.sandboxDir; } catch {}
  }
  return sandboxRoot(sessionId);
}

async function resolveDir(sessionId: string, dir?: string): Promise<string> {
  if (!dir) return workDir(sessionId);
  const root = await sandboxRoot(sessionId);
  const target = sanitizePath(dir, root);
  await fs.mkdir(target, { recursive: true });
  return await sanitizeExistingPath(target, root);
}

interface PersistentShell { proc: ChildProcess; buf: string; busy: boolean; }
const persistentShells = new Map<string, PersistentShell>();
const SHELL_HANG_MS = 60000;

function shellKey(sessionId: string): string {
  return `${getAuthKeyForSession(sessionId)}::${sessionId}`;
}

const shellCreation = new Map<string, Promise<PersistentShell>>();

async function getShell(sessionId: string): Promise<PersistentShell> {
  const key = shellKey(sessionId);
  const existing = persistentShells.get(key);
  if (existing && !existing.proc.killed) return existing;

  const inFlight = shellCreation.get(key);
  if (inFlight) return inFlight;

  const creation = (async () => {
    const cwd = await workDir(sessionId);
    if (sandboxMode() === 'disabled') throw new Error('Sandbox is disabled. Set SANDBOX_MODE=bwrap for production isolation.');
    if (sandboxMode() === 'host') {
      const proc = spawn('bash', ['--noprofile', '--norc'], { cwd, env: sandboxEnv(sessionId), stdio: ['pipe', 'pipe', 'pipe'] });
      const shell: PersistentShell = { proc, buf: '', busy: false };
      proc.stdout?.on('data', (d) => { shell.buf = appendCapped(shell.buf, d.toString(), BG_BUF_CAP); });
      proc.on('exit', () => { if (persistentShells.get(key) === shell) persistentShells.delete(key); });
      persistentShells.set(key, shell);
      return shell;
    }
    const args = bwrapArgs(sessionId, cwd, '', false);
    const commandIndex = args.lastIndexOf('-lc');
    args[commandIndex + 1] = '';
    const proc = spawn('bwrap', args, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] });
    const shell: PersistentShell = { proc, buf: '', busy: false };
    proc.stdout?.on('data', (d) => { shell.buf = appendCapped(shell.buf, d.toString(), BG_BUF_CAP); });
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
    check();
  });
}

export async function destroySandbox(sessionId: string, options: { deleteContext?: boolean } = { deleteContext: true }): Promise<void> {
  const authKey = getAuthKeyForSession(sessionId);
  const dirToRemove = path.join(os.tmpdir(), `krix_sbx_${authKey}`);
  const shellToKill = shellKey(sessionId);
  if (options.deleteContext) {
    deleteSessionContext(sessionId);
  }
  killShell(shellToKill);
  outputCache.delete(sessionId);
  const table = processTables.get(sessionId);
  if (table) {
    for (const [, item] of table) { try { item.proc.kill('SIGKILL'); } catch {} }
    processTables.delete(sessionId);
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function validGitRef(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
    !value.startsWith('-') && !value.endsWith('.') && !value.endsWith('/') &&
    !value.includes('..') && !value.includes('@{') && !/[\u0000-\u001F\u007F ~^:?*[\\]/.test(value);
}

async function safeReadText(abs: string): Promise<string> {
  const handle = await fs.open(abs, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try { return await handle.readFile('utf-8'); } finally { await handle.close(); }
}

async function safeWriteText(abs: string, content: string, append = false): Promise<void> {
  const flags = append
    ? (fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_APPEND | fsSync.constants.O_NOFOLLOW)
    : (fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW);
  const handle = await fs.open(abs, flags, 0o600);
  try { await handle.writeFile(content, 'utf-8'); } finally { await handle.close(); }
}

function validRepoPart(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
}

function runGit(args: string[], cwd: string, timeout: number, token?: string): Promise<{ err: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    };
    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
    }
    const safeArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', ...args];
    execFile('git', safeArgs, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
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
        if (procTable(sessionId).size >= MAX_BACKGROUND_PROCESSES) throw new Error(`Maximum of ${MAX_BACKGROUND_PROCESSES} background sandbox processes reached.`);
        if (sandboxMode() === 'disabled') throw new Error('Sandbox is disabled. Set SANDBOX_MODE=bwrap for production isolation.');
        let proc: ChildProcess;
        if (sandboxMode() === 'host') {
          proc = spawn('/bin/bash', ['--noprofile', '--norc', '-lc', args.command], { cwd, env: sandboxEnv(sessionId), stdio: ['ignore', 'pipe', 'pipe'] });
        } else {
          proc = spawn('bwrap', bwrapArgs(sessionId, cwd, args.command, false), { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
        }
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
      const extraArgs = (args.args || []).map((value: string) => shellQuote(value)).join(' ');

      let cmd: string;
      if (args.filePath) {
        const abs = await sanitizeExistingPath(args.filePath, cwd);
        const ext = path.extname(abs).toLowerCase();
        if (COMPILED_EXTS.has(ext)) {
          createdBin = path.join(cwd, `_sbx_out_${crypto.randomBytes(12).toString('hex')}`);
          cmd = fileRunCmd(ext, abs, extraArgs, createdBin!);
        } else {
          cmd = fileRunCmd(ext, abs, extraArgs);
        }
      } else if (args.code) {
        const ext = EXT_BY_LANG[args.lang || 'py'] || '.py';
        tmp = path.join(cwd, `_snippet_${crypto.randomBytes(12).toString('hex')}${ext}`);
        await safeWriteText(tmp!, args.code);
        if (COMPILED_EXTS.has(ext)) {
          createdBin = path.join(cwd, `_sbx_out_${crypto.randomBytes(12).toString('hex')}`);
          cmd = fileRunCmd(ext, tmp!, extraArgs, createdBin!);
        } else {
          cmd = fileRunCmd(ext, tmp!, extraArgs);
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
      const cwd = args.dir ? await resolveDir(sessionId, args.dir) : await sandboxRoot(sessionId);
      const packages = args.packages.map((value: string) => { if (!/^[A-Za-z0-9@_./:+=-]{1,200}$/.test(value) || value.startsWith('-')) throw new Error(`Invalid package spec: ${value}`); return shellQuote(value); });
      const list = packages.join(' ');
      const cmd = args.manager === 'npm' ? `npm install --ignore-scripts ${list}` : `pip install --disable-pip-version-check --no-input --target=. ${list}`;
      const { err, stdout, stderr } = await run(cmd, cwd, 90000, sessionId, true);
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

    const now = Date.now();
    for (const [pid, item] of table) {
      if (item.status === 'running' && now - item.startTime.getTime() > MAX_BACKGROUND_LIFETIME_MS) { try { item.proc.kill('SIGKILL'); } catch {} }
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
      const abs = args.action === 'read' || args.action === 'delete' || args.action === 'edit'
        ? await sanitizeExistingPath(args.path, base)
        : await sanitizeWritablePath(args.path, base);

      if (args.action === 'read') {
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) return formatError(`No such file: ${args.path}`);
        if (stat.size > MAX_FILE_BYTES) return formatError(`File exceeds the ${MAX_FILE_BYTES} byte safety limit.`);
        const content = await safeReadText(abs);
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
        if (stat.size > MAX_FILE_BYTES) return formatError(`File exceeds the ${MAX_FILE_BYTES} byte safety limit.`);
        const content = await safeReadText(abs);
        const count = content.split(args.old_str).length - 1;
        if (count === 0) return formatError('old_str not found in file.');
        if (count > 1) return formatError(`old_str matches ${count} places — make it unique by including more surrounding context.`);
        const idx = content.indexOf(args.old_str);
        const updated = content.slice(0, idx) + args.new_str + content.slice(idx + args.old_str.length);
        await safeWriteText(abs, updated);
        const newStat = await fs.stat(abs);
        return formatOptimizedResponse({ edited: args.path, sizeBytes: newStat.size });
      }

      if (args.content === undefined) return formatError('`content` is required for write/append.');
      if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) return formatError(`Content exceeds the ${MAX_FILE_BYTES} byte safety limit.`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (args.action === 'append') await safeWriteText(abs, args.content, true);
      else await safeWriteText(abs, args.content);
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
      check('bwrap', 'bwrap --version');

      const ctx = getSessionContext(sessionId);
      let cloned = false;
      if (ctx.sandboxDir) {
        try { await fs.access(ctx.sandboxDir); cloned = true; }
        catch { updateSessionContext(sessionId, { sandboxDir: undefined }); }
      }
      const maxMemMB = 400;
      const usedMemMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      const freeMemMB = Math.max(0, Math.min(maxMemMB, maxMemMB - usedMemMB));

      return formatOptimizedResponse({
        freeMemMB,
        maxMemMB,
        runtimes,
        repo: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : undefined,
        branch: ctx.branch,
        cloned,
        cwd: ctx.cwd,
        envVars: ctx.env ? Object.keys(ctx.env).length : undefined,
        persistentShellAlive: !!persistentShells.get(shellKey(sessionId)),
        isolationMode: sandboxMode(),
        ...(ctx.resumedContext ? { resumed: true, resumedAfterIdleMs: ctx.resumedContext.idleMs } : { resumed: false })
      });
    } catch (err) { return formatError(err); }
  });

  reg('git_clone', {
    description: 'Clone a repository into the isolated sandbox. Network access is used only by this fixed git operation; arbitrary sandbox commands have no network access in bwrap mode.',
    inputSchema: { owner: z.string().min(1).max(100).optional(), repo: z.string().min(1).max(100).optional(), branch: z.string().optional(), depth: z.number().int().min(1).max(50).optional().default(1) },
    annotations: getToolAnnotations('git_clone')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      const owner = args.owner || ctx.owner;
      const repo = args.repo || ctx.repo;
      if (!owner || !repo || !validRepoPart(owner) || !validRepoPart(repo)) throw new Error('Invalid GitHub owner/repository name.');
      const branch = args.branch || ctx.branch || 'main';
      if (!validGitRef(branch)) throw new Error('Invalid branch name.');
      if (!githubToken) throw new Error('A server-side GitHub token is required for sandbox git operations.');
      const root = await sandboxRoot(sessionId);
      const dest = path.join(root, owner, repo);
      const relative = path.relative(root, dest);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Repository path escaped sandbox.');

      let isExisting = false;
      try { const stat = await fs.stat(path.join(dest, '.git')); isExisting = stat.isDirectory(); } catch {}
      if (isExisting) {
        let result = await runGit(['checkout', branch], dest, 15000, githubToken);
        if (result.err) {
          const fetched = await runGit(['fetch', '--no-tags', 'origin', `${branch}:${branch}`], dest, 30000, githubToken);
          if (!fetched.err) result = await runGit(['checkout', branch], dest, 15000, githubToken);
          else result = await runGit(['fetch', '--no-tags', 'origin', branch], dest, 30000, githubToken);
        }
        if (!result.err) {
          await runGit(['config', 'user.email', 'agent@sandbox.local'], dest, 5000);
          await runGit(['config', 'user.name', 'Krix Sandbox'], dest, 5000);
        }
        updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
        return formatOptimizedResponse({ note: 'already cloned', branch, path: dest, ...(result.err ? { checkoutWarning: `Could not switch to branch '${branch}'` } : {}) });
      }

      await fs.mkdir(path.dirname(dest), { recursive: true });
      const url = `https://github.com/${owner}/${repo}.git`;
      const result = await runGit(['clone', '--no-checkout', '--depth', String(args.depth || 1), '--branch', branch, '--single-branch', url, dest], root, 120000, githubToken);
      if (result.err) return execResponse(sessionId, result.err, result.stdout, result.stderr);
      const checkout = await runGit(['checkout', branch], dest, 60000, githubToken);
      if (checkout.err) return execResponse(sessionId, checkout.err, checkout.stdout, checkout.stderr);
      await runGit(['config', 'user.email', 'agent@sandbox.local'], dest, 5000);
      await runGit(['config', 'user.name', 'Krix Sandbox'], dest, 5000);
      updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
      return formatOptimizedResponse({ cloned: `${owner}/${repo}`, branch, path: dest });
    } catch (err) { return formatError(err); }
  });

  reg('git_checkout', {
    description: 'Switch or create a branch in the active cloned repo. Automatically fetches the branch from origin first if it is not yet known locally.',
    inputSchema: { branch: z.string(), create: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('git_checkout')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      if (!validGitRef(args.branch)) throw new Error('Invalid branch name.');
      let result = await runGit(['checkout', ...(args.create ? ['-b'] : []), args.branch], ctx.sandboxDir, 15000, githubToken);
      let { err, stdout, stderr } = result;
      if (err && !args.create) {
        const fetchResult = await runGit(['fetch', '--no-tags', 'origin', `${args.branch}:${args.branch}`], ctx.sandboxDir, 30000, githubToken);
        if (!fetchResult.err) ({ err, stdout, stderr } = await runGit(['checkout', args.branch], ctx.sandboxDir, 15000, githubToken));
      }
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
      const { err, stdout, stderr } = await runGit(['pull', '--ff-only'], ctx.sandboxDir, 30000, githubToken);
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
      const { err, stdout, stderr } = await runGit(['status', '--porcelain=v1', '-b'], ctx.sandboxDir, 10000, githubToken);
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
      const diffArgs = ['diff', ...(args.staged ? ['--cached'] : []), '--'];
      if (args.path) diffArgs.push(args.path);
      const { err, stdout, stderr } = await runGit(diffArgs, ctx.sandboxDir, 10000, githubToken);
      return execResponse(sessionId, err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('git_commit_push', {
    description: 'Stage, commit, and (by default) push changes in the cloned repo.',
    inputSchema: { message: z.string(), push: z.boolean().optional().default(true), branch: z.string().optional() },
    annotations: getToolAnnotations('git_commit_push')
  }, async (args: any) => {
    try {
      const ctx = getSessionContext(sessionId);
      if (!ctx.sandboxDir) throw new Error('No repo cloned. Call git_clone first.');
      const branch = args.branch || ctx.branch || 'main';
      if (args.branch) {
        updateSessionContext(sessionId, { branch: args.branch });
        if (!validGitRef(args.branch)) throw new Error('Invalid branch name.');
        const checkout = await runGit(['checkout', args.branch], ctx.sandboxDir, 10000, githubToken);
        if (checkout.err) return execResponse(sessionId, checkout.err, checkout.stdout, checkout.stderr);
      }

      const add = await runGit(['add', '-A'], ctx.sandboxDir, 10000, githubToken);
      if (add.err) return execResponse(sessionId, add.err, add.stdout, add.stderr);

      const commit = await runGit(['commit', '-m', args.message], ctx.sandboxDir, 10000, githubToken);
      if (commit.err) return execResponse(sessionId, commit.err, commit.stdout, commit.stderr);

      if (!args.push) return formatOptimizedResponse({ committed: true });

      if (!validGitRef(branch)) throw new Error('Invalid branch name.');
      const push = await runGit(['push', '-u', 'origin', branch], ctx.sandboxDir, 30000, githubToken);
      if (push.err) return execResponse(sessionId, push.err, push.stdout, push.stderr);
      return formatOptimizedResponse({ committed: true, pushed: branch });
    } catch (err) { return formatError(err); }
  });
}

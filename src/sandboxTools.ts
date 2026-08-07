import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec, execSync, spawn, type ChildProcess } from 'node:child_process';
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

const OUT_CAP = 2000;
const BG_BUF_CAP = 20000;
const EXEC_LIMITS = { maxBuffer: 4 * 1024 * 1024 };

const processTables = new Map<string, Map<number, ActiveProcess>>();
function procTable(sessionId: string): Map<number, ActiveProcess> {
  let t = processTables.get(sessionId);
  if (!t) { t = new Map(); processTables.set(sessionId, t); }
  return t;
}

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

function execResponse(err: any, stdout: string, stderr: string) {
  const out: Record<string, any> = {};
  const o = trunc(stdout || '');
  const e = trunc(stderr || '');
  if (o) out.stdout = o;
  if (e) out.stderr = e;
  if (err) out.exit = typeof err.code === 'number' ? err.code : 1;
  return formatOptimizedResponse(Object.keys(out).length ? out : { stdout: '(ok, no output)' });
}

function sandboxEnv(): NodeJS.ProcessEnv {
  // process.env.HOME can point at a directory that doesn't exist in this
  // container (e.g. /home/sbx_userXXXX), which makes npm/pip fail with
  // ENOENT trying to create their cache/config dirs there. Pin HOME (and
  // the npm cache) to the sandbox's own writable tmp dir instead.
  const safeHome = path.join(os.tmpdir(), 'krix_home');
  try { require('node:fs').mkdirSync(safeHome, { recursive: true }); } catch {}
  return {
    ...process.env,
    HOME: safeHome,
    npm_config_cache: path.join(safeHome, '.npm'),
  };
}

function run(cmd: string, cwd: string, timeout: number = 30000): Promise<{ err: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, env: sandboxEnv(), ...EXEC_LIMITS }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function sandboxRoot(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function workDir(sessionId: string): Promise<string> {
  const ctx = getSessionContext(sessionId);
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

export async function destroySandbox(sessionId: string): Promise<void> {
  // Capture the real auth-scoped directory BEFORE deleting session context —
  // deleteSessionContext() removes the sessionId->authKey mapping, after
  // which getAuthKeyForSession() falls back to 'anonymous' and would delete
  // the wrong (nonexistent) directory, leaving the real one untouched.
  const dirToRemove = path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
  deleteSessionContext(sessionId);
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
    default: throw new Error(`Unsupported extension '${ext}'. Use py/js/ts/sh/go/java/cpp.`);
  }
}

const EXT_BY_LANG: Record<string, string> = { py: '.py', js: '.js', ts: '.ts', sh: '.sh', go: '.go', java: '.java', cpp: '.cpp' };

function authFlag(token?: string): string {
  if (!token) return '';
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `-c http.extraHeader="Authorization: Basic ${b64}" `;
}

export function registerSandboxTools(server: McpServer, sessionId: string, githubToken: string | undefined, registry: Record<string, any>) {
  const reg = makeRegistrar(server, registry);

  reg('sandbox_exec', {
    description: 'Run a shell command in the sandbox. Defaults to the active cloned repo if one exists, else scratch dir — pass `dir` to target any other sandbox path. Pass `background: true` to run detached and track it via sandbox_ps.',
    inputSchema: { command: z.string(), timeoutMs: z.number().optional(), dir: z.string().optional(), background: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('sandbox_exec')
  }, async (args: any) => {
    try {
      sanitizeCommand(args.command);
      const cwd = await resolveDir(sessionId, args.dir);

      if (args.background) {
        const proc = spawn(args.command, { cwd, shell: true, env: sandboxEnv() });
        if (!proc.pid) throw new Error('Failed to start background process.');
        const pid = proc.pid;
        const entry: ActiveProcess = { pid, command: args.command, proc, startTime: new Date(), status: 'running', exitCode: null, stdout: '', stderr: '' };
        procTable(sessionId).set(pid, entry);
        proc.stdout?.on('data', (d) => { entry.stdout = appendCapped(entry.stdout, d.toString()); });
        proc.stderr?.on('data', (d) => { entry.stderr = appendCapped(entry.stderr, d.toString()); });
        proc.on('exit', (code) => { entry.status = 'exited'; entry.exitCode = code; });
        return formatOptimizedResponse({ started: pid, command: args.command, dir: cwd });
      }

      const { err, stdout, stderr } = await run(args.command, cwd, Math.min(args.timeoutMs || 30000, 120000));
      return execResponse(err, stdout, stderr);
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_run', {
    description: 'Run code: pass inline `code` (+ optional `lang`, default py) or an existing `filePath`. Langs: py,js,ts,sh,go,java,cpp. Pass `dir` to run in any sandbox directory instead of the default workDir.',
    inputSchema: {
      lang: z.enum(['py', 'js', 'ts', 'sh', 'go', 'java', 'cpp']).optional(),
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
        if (ext === '.cpp') {
          createdBin = path.join(cwd, `_sbx_out_${Date.now()}`);
          cmd = fileRunCmd(ext, abs, extraArgs, createdBin);
        } else {
          cmd = fileRunCmd(ext, abs, extraArgs);
        }
      } else if (args.code) {
        const ext = EXT_BY_LANG[args.lang || 'py'] || '.py';
        tmp = path.join(cwd, `_snippet_${Date.now()}${ext}`);
        await fs.writeFile(tmp, args.code, 'utf-8');
        if (ext === '.cpp') {
          createdBin = path.join(cwd, `_sbx_out_${Date.now()}`);
          cmd = fileRunCmd(ext, tmp, extraArgs, createdBin);
        } else {
          cmd = fileRunCmd(ext, tmp, extraArgs);
        }
      } else {
        throw new Error('Provide either `code` or `filePath`.');
      }

      const { err, stdout, stderr } = await run(cmd, cwd, 45000);
      return execResponse(err, stdout, stderr);
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
      const { err, stdout, stderr } = await run(cmd, cwd, 90000);
      if (err) return execResponse(err, stdout, stderr);
      return formatOptimizedResponse({ installed: args.packages, path: cwd });
    } catch (err) { return formatError(err); }
  });

  const EXITED_TTL_MS = 10 * 60 * 1000;

  reg('sandbox_ps', {
    description: 'List, kill (pid or "all"), or fetch output of background sandbox processes started via sandbox_exec(background:true).',
    inputSchema: { action: z.enum(['list', 'kill', 'output']).default('list'), pid: z.union([z.number(), z.literal('all')]).optional() },
    annotations: getToolAnnotations('sandbox_ps')
  }, async (args: any) => {
    const table = procTable(sessionId);

    // Prune old exited entries so the table doesn't grow unbounded across
    // many background runs — running processes are never pruned.
    const now = Date.now();
    for (const [pid, item] of table) {
      if (item.status === 'exited' && now - item.startTime.getTime() > EXITED_TTL_MS) table.delete(pid);
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
      const out: Record<string, any> = { pid: item.pid, status: item.status, exitCode: item.exitCode };
      const o = trunc(item.stdout, BG_BUF_CAP);
      const e = trunc(item.stderr, BG_BUF_CAP);
      if (o) out.stdout = o;
      if (e) out.stderr = e;
      return formatOptimizedResponse(out);
    }

    const list = Array.from(table.values()).map(p => ({
      pid: p.pid, command: p.command, status: p.status, exitCode: p.exitCode
    }));
    return formatOptimizedResponse(list.length ? list : 'No active processes.');
  });

  reg('sandbox_file', {
    description: 'Read, write, append to, or delete a file in the sandbox — safer than shell-escaping content through sandbox_exec.',
    inputSchema: {
      action: z.enum(['read', 'write', 'append', 'delete']),
      path: z.string(),
      content: z.string().optional(),
      dir: z.string().optional()
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
        const out: Record<string, any> = { sizeBytes: stat.size };
        const c = trunc(content, 10000);
        if (c) out.content = c;
        return formatOptimizedResponse(out);
      }

      if (args.action === 'delete') {
        await fs.unlink(abs);
        return formatOptimizedResponse({ deleted: args.path });
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
    description: 'Wipe the sandbox: scratch files, cloned repo, and background processes.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_reset')
  }, async () => {
    try {
      await destroySandbox(sessionId);
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
        cloned
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
      if (err) return execResponse(err, stdout, stderr);

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
      if (err) return execResponse(err, stdout, stderr);
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
      return execResponse(err, stdout, stderr);
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
      return execResponse(err, stdout, stderr);
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
      return execResponse(err, stdout, stderr);
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
      if (add.err) return execResponse(add.err, add.stdout, add.stderr);

      const commit = await run(`git commit -m ${JSON.stringify(args.message)}`, ctx.sandboxDir, 10000);
      if (commit.err) return execResponse(commit.err, commit.stdout, commit.stderr);

      if (!args.push) return formatOptimizedResponse({ committed: true });

      const push = await run(`git ${authFlag(githubToken)}push -u origin ${branch}`, ctx.sandboxDir, 30000);
      if (push.err) return execResponse(push.err, push.stdout, push.stderr);
      return formatOptimizedResponse({ committed: true, pushed: branch });
    } catch (err) { return formatError(err); }
  });
}

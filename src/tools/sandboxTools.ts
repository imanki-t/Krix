import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations,
  sanitizeCommand, sanitizePath, getSessionContext, updateSessionContext, deleteSessionContext, makeRegistrar
} from '../core/security.js';
import { loadSettings } from '../config/settings.js';

interface ActiveProcess {
  pid: number;
  command: string;
  proc: ChildProcess;
  startTime: Date;
}

const OUT_CAP = 3000;
const EXEC_LIMITS = { maxBuffer: 4 * 1024 * 1024 };

const processTables = new Map<string, Map<number, ActiveProcess>>();

function procTable(sessionId: string): Map<number, ActiveProcess> {
  if (!processTables.has(sessionId)) {
    processTables.set(sessionId, new Map());
  }
  return processTables.get(sessionId)!;
}

async function getOrCreateSandbox(sessionId: string): Promise<string> {
  const ctx = getSessionContext(sessionId);
  if (ctx.sandboxDir) {
    try {
      await fs.access(ctx.sandboxDir);
      return ctx.sandboxDir;
    } catch {}
  }

  const base = path.join(os.tmpdir(), 'krix-sandboxes');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, `sb-${sessionId.slice(0, 8)}-`));
  updateSessionContext(sessionId, { sandboxDir: dir });
  return dir;
}

export function destroySandbox(sessionId: string): void {
  const table = processTables.get(sessionId);
  if (table) {
    for (const [pid, ap] of table.entries()) {
      try {
        // Try killing process group first, fallback to individual PID
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    table.clear();
    processTables.delete(sessionId);
  }

  const ctx = getSessionContext(sessionId);
  if (ctx.sandboxDir) {
    fs.rm(ctx.sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
  deleteSessionContext(sessionId);
}

function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  sessionId: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const table = procTable(sessionId);
    const child = exec(cmd, { cwd, timeout: timeoutMs, ...EXEC_LIMITS }, (err, stdout, stderr) => {
      if (child.pid) table.delete(child.pid);
      if (err) {
        resolve({
          stdout: (stdout || '').slice(0, OUT_CAP),
          stderr: (stderr || err.message).slice(0, OUT_CAP),
          exitCode: typeof err.code === 'number' ? err.code : 1
        });
      } else {
        resolve({
          stdout: (stdout || '').slice(0, OUT_CAP),
          stderr: (stderr || '').slice(0, OUT_CAP),
          exitCode: 0
        });
      }
    });

    if (child.pid) {
      table.set(child.pid, {
        pid: child.pid,
        command: cmd.slice(0, 80),
        proc: child,
        startTime: new Date()
      });
    }
  });
}

function buildExecutionCommand(
  runtime: string,
  filePath: string,
  outPath?: string
): { compileCmd?: string; runCmd: string } {
  switch (runtime) {
    case 'py':
      return { runCmd: `python3 "${filePath}"` };
    case 'js':
      return { runCmd: `node "${filePath}"` };
    case 'ts':
      return { runCmd: `npx --yes tsx "${filePath}"` };
    case 'sh':
      return { runCmd: `bash "${filePath}"` };
    case 'go':
      return { runCmd: `go run "${filePath}"` };
    case 'java':
      return { runCmd: `java "${filePath}"` };
    case 'cpp':
      return {
        compileCmd: `g++ -O2 -std=c++17 -o "${outPath}" "${filePath}"`,
        runCmd: `"${outPath}"`
      };
    default:
      throw new Error(`Unsupported runtime: ${runtime}`);
  }
}

export function registerSandboxTools(
  server: McpServer,
  sessionId: string,
  githubToken?: string,
  registry: Record<string, any> = {}
) {
  const register = makeRegistrar(server, registry);

  register('sandbox_run', {
    description: 'Execute a script in a chosen runtime (py, js, ts, sh, go, java, cpp) within an isolated ephemeral sandbox.',
    inputSchema: {
      runtime: z.enum(['py', 'js', 'ts', 'sh', 'go', 'java', 'cpp']).describe('Execution runtime'),
      code: z.string().describe('Source code to execute'),
      args: z.array(z.string()).optional().describe('Command-line arguments to pass to the script'),
      timeoutMs: z.number().optional().describe('Execution timeout in milliseconds (max 60000, default 15000)')
    },
    annotations: getToolAnnotations('sandbox_run')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const settings = loadSettings();
      const timeout = Math.min(input.timeoutMs || settings.sandbox.defaultTimeoutMs || 15000, 60000);
      const extMap: Record<string, string> = {
        py: 'py', js: 'js', ts: 'ts', sh: 'sh', go: 'go', java: 'java', cpp: 'cpp'
      };

      const fileName = `script_${Date.now()}.${extMap[input.runtime]}`;
      const filePath = path.join(sandboxDir, fileName);
      const binPath = path.join(sandboxDir, `bin_${Date.now()}`);

      await fs.writeFile(filePath, input.code, 'utf-8');

      const { compileCmd, runCmd } = buildExecutionCommand(input.runtime, filePath, binPath);

      if (compileCmd) {
        const compileRes = await runCommand(compileCmd, sandboxDir, 20000, sessionId);
        if (compileRes.exitCode !== 0) {
          return formatOptimizedResponse({
            phase: 'compilation_failed',
            exitCode: compileRes.exitCode,
            error: compileRes.stderr || compileRes.stdout
          });
        }
      }

      const extraArgs = (input.args || []).map((a: string) => {
        // Sanitize shell metacharacters in arguments
        const sanitized = a.replace(/[`$\\"!#&|;(){}\[\]<>\n\r]/g, '');
        return `"${sanitized}"`;
      }).join(' ');
      const fullCmd = extraArgs ? `${runCmd} ${extraArgs}` : runCmd;

      const result = await runCommand(fullCmd, sandboxDir, timeout, sessionId);

      fs.unlink(filePath).catch(() => {});
      if (compileCmd) fs.unlink(binPath).catch(() => {});

      return formatOptimizedResponse({
        runtime: input.runtime,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.exitCode === 0
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('sandbox_exec', {
    description: 'Run an arbitrary shell command within the session sandbox directory.',
    inputSchema: {
      command: z.string().describe('Shell command to execute'),
      cwd: z.string().optional().describe('Working directory relative to the sandbox root'),
      timeoutMs: z.number().optional().describe('Timeout in milliseconds (max 60000, default 15000)')
    },
    annotations: getToolAnnotations('sandbox_exec')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const targetCwd = input.cwd ? sanitizePath(input.cwd, sandboxDir) : sandboxDir;
      const ctx = getSessionContext(sessionId);
      const cleanCmd = sanitizeCommand(input.command, ctx.securityTier);
      const timeout = Math.min(input.timeoutMs || 15000, 60000);

      const result = await runCommand(cleanCmd, targetCwd, timeout, sessionId);
      return formatOptimizedResponse({
        command: input.command,
        cwd: path.relative(sandboxDir, targetCwd) || '.',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.exitCode === 0
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('sandbox_install', {
    description: 'Install dependencies into the sandbox workspace (e.g. npm packages or pip requirements).',
    inputSchema: {
      manager: z.enum(['npm', 'pip']).describe('Package manager to use'),
      packages: z.array(z.string()).describe('List of packages to install (e.g. ["lodash", "axios"] or ["numpy", "pandas"])')
    },
    annotations: getToolAnnotations('sandbox_install')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const invalidFlag = input.packages.find((p: string) => p.trim().startsWith('-'));
      if (invalidFlag) {
        throw new Error(`Invalid package name: '${invalidFlag}'. Package names cannot start with '-' or '--'.`);
      }

      const safePackages = input.packages.map((p: string) => p.replace(/[^a-zA-Z0-9@_./~-]/g, '')).filter(Boolean).join(' ');
      if (!safePackages) {
        throw new Error('No valid package names provided.');
      }

      let cmd: string;
      if (input.manager === 'npm') {
        cmd = `npm install --no-audit --no-fund ${safePackages}`;
      } else {
        cmd = `pip install --no-cache-dir ${safePackages}`;
      }

      const result = await runCommand(cmd, sandboxDir, 60000, sessionId);
      return formatOptimizedResponse({
        manager: input.manager,
        packages: input.packages,
        exitCode: result.exitCode,
        output: (result.stdout + '\n' + result.stderr).trim(),
        success: result.exitCode === 0
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('sandbox_ps', {
    description: 'List all running processes initiated in this sandbox session.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_ps')
  }, async () => {
    const table = procTable(sessionId);
    const list = Array.from(table.values()).map(p => ({
      pid: p.pid,
      command: p.command,
      startTime: p.startTime.toISOString(),
      uptimeSeconds: Math.round((Date.now() - p.startTime.getTime()) / 1000)
    }));
    return formatOptimizedResponse({ activeProcesses: list, total: list.length });
  });

  register('sandbox_reset', {
    description: 'Terminate all active processes and delete the ephemeral sandbox directory.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_reset')
  }, async () => {
    destroySandbox(sessionId);
    return formatOptimizedResponse({ status: 'Sandbox destroyed and reset.' });
  });

  register('sandbox_status', {
    description: 'Inspect the status of the current sandbox, including runtime availability and memory.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_status')
  }, async () => {
    const ctx = getSessionContext(sessionId);
    const table = procTable(sessionId);

    const runtimes: Record<string, boolean> = {};
    for (const [name, cmd] of Object.entries({
      python3: 'python3 --version',
      node: 'node --version',
      bash: 'bash --version',
      go: 'go version',
      java: 'java -version',
      gpp: 'g++ --version'
    })) {
      try {
        execSync(cmd, { stdio: 'ignore', timeout: 2000 });
        runtimes[name] = true;
      } catch {
        runtimes[name] = false;
      }
    }

    return formatOptimizedResponse({
      sessionId,
      sandboxInitialized: Boolean(ctx.sandboxDir),
      activeProcesses: table.size,
      availableRuntimes: runtimes,
      systemFreeMemMB: Math.round(os.freemem() / (1024 * 1024)),
      systemTotalMemMB: Math.round(os.totalmem() / (1024 * 1024))
    });
  });

  register('git_clone', {
    description: 'Clone a GitHub repository into the session sandbox for local git operations.',
    inputSchema: {
      repoUrl: z.string().describe('HTTPS URL of the repository (e.g. https://github.com/owner/repo)'),
      directoryName: z.string().optional().describe('Target folder name inside the sandbox (defaults to repo name)'),
      branch: z.string().optional().describe('Specific branch to clone')
    },
    annotations: getToolAnnotations('git_clone')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      if (!input.repoUrl || !input.repoUrl.startsWith('http')) {
        throw new Error("Invalid repository URL. Only HTTP/HTTPS URLs are allowed.");
      }
      if (input.repoUrl.trim().startsWith('-')) {
        throw new Error("Invalid repository URL.");
      }

      let cloneUrl = input.repoUrl;
      if (githubToken && !cloneUrl.includes('@')) {
        cloneUrl = cloneUrl.replace('https://', `https://x-access-token:${githubToken}@`);
      }

      let branchFlag = '';
      if (input.branch) {
        const safeBranch = input.branch.replace(/[^a-zA-Z0-9_.\-\/]/g, '');
        if (safeBranch.startsWith('-')) throw new Error("Invalid branch name.");
        branchFlag = `-b "${safeBranch}"`;
      }

      const destDir = input.directoryName ? path.basename(input.directoryName).replace(/[^a-zA-Z0-9_.\-]/g, '') : '';
      if (destDir.startsWith('-')) throw new Error("Invalid destination directory name.");

      const cmd = `git clone --depth 50 ${branchFlag} "${cloneUrl}" ${destDir}`.trim();

      const result = await runCommand(cmd, sandboxDir, 45000, sessionId);
      const cleanOutput = (result.stdout || result.stderr).replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
      return formatOptimizedResponse({
        repoUrl: input.repoUrl,
        success: result.exitCode === 0,
        output: cleanOutput
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('git_checkout', {
    description: 'Switch or create a branch within a cloned repository in the sandbox.',
    inputSchema: {
      repoPath: z.string().describe('Path to the repo relative to the sandbox root'),
      branch: z.string().describe('Branch name to switch to'),
      create: z.boolean().optional().describe('Whether to create the branch (-b flag)')
    },
    annotations: getToolAnnotations('git_checkout')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const cwd = sanitizePath(input.repoPath, sandboxDir);
      const flag = input.create ? '-b' : '';
      const safeBranch = input.branch.replace(/[^a-zA-Z0-9_.\-\/]/g, '');
      if (!safeBranch || safeBranch.startsWith('-')) throw new Error('Invalid branch name.');
      const cmd = `git checkout ${flag} "${safeBranch}"`.trim();

      const result = await runCommand(cmd, cwd, 10000, sessionId);
      return formatOptimizedResponse({
        branch: input.branch,
        success: result.exitCode === 0,
        output: result.stdout || result.stderr
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('git_pull', {
    description: 'Fetch and merge changes from the remote branch into the sandbox repository.',
    inputSchema: {
      repoPath: z.string().describe('Path to the repo relative to sandbox root'),
      remote: z.string().optional().describe('Remote name (defaults to origin)'),
      branch: z.string().optional().describe('Branch name (defaults to current)')
    },
    annotations: getToolAnnotations('git_pull')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const cwd = sanitizePath(input.repoPath, sandboxDir);
      const remote = (input.remote || 'origin').replace(/[^a-zA-Z0-9_.\-]/g, '');
      if (remote.startsWith('-')) throw new Error('Invalid remote name.');
      const branch = (input.branch || '').replace(/[^a-zA-Z0-9_.\-\/]/g, '');
      if (branch.startsWith('-')) throw new Error('Invalid branch name.');
      const cmd = `git pull ${remote} ${branch}`.trim();

      const result = await runCommand(cmd, cwd, 20000, sessionId);
      return formatOptimizedResponse({
        success: result.exitCode === 0,
        output: result.stdout || result.stderr
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('git_status', {
    description: 'Check modified, staged, and untracked files in the cloned repository.',
    inputSchema: { repoPath: z.string().describe('Path to repo relative to sandbox root') },
    annotations: getToolAnnotations('git_status')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const cwd = sanitizePath(input.repoPath, sandboxDir);
      const result = await runCommand('git status --short --branch', cwd, 10000, sessionId);
      return formatOptimizedResponse({
        status: result.stdout.trim(),
        success: result.exitCode === 0
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('git_diff', {
    description: 'View uncommitted changes or diff against a commit in the sandbox repo.',
    inputSchema: {
      repoPath: z.string().describe('Path to repo relative to sandbox root'),
      staged: z.boolean().optional().describe('View staged changes only (--cached)'),
      commit: z.string().optional().describe('Compare against a specific commit hash')
    },
    annotations: getToolAnnotations('git_diff')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const cwd = sanitizePath(input.repoPath, sandboxDir);
      const safeCommit = (input.commit || '').replace(/[^a-fA-F0-9]/g, '');
      const flag = input.staged ? '--cached' : safeCommit;
      const result = await runCommand(`git diff ${flag}`, cwd, 10000, sessionId);
      return formatOptimizedResponse({
        diff: result.stdout.slice(0, 5000),
        truncated: result.stdout.length > 5000
      });
    } catch (err: any) {
      return formatError(err);
    }
  });

  register('git_commit_push', {
    description: 'Stage all changes, commit with a message, and push to the remote repository.',
    inputSchema: {
      repoPath: z.string().describe('Path to repo relative to sandbox root'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Branch to push to')
    },
    annotations: getToolAnnotations('git_commit_push')
  }, async (input) => {
    try {
      const sandboxDir = await getOrCreateSandbox(sessionId);
      const cwd = sanitizePath(input.repoPath, sandboxDir);
      const rawBranch = input.branch || 'HEAD';
      const branch = rawBranch.replace(/[^a-zA-Z0-9_.\-\/]/g, '');
      if (branch.startsWith('-')) throw new Error('Invalid branch name.');

      const addRes = await runCommand('git add -A', cwd, 10000, sessionId);
      if (addRes.exitCode !== 0) return formatError(new Error(`git add failed: ${addRes.stderr}`));

      // Write commit message to temp file to eliminate shell quoting vulnerabilities
      const msgFile = path.join(sandboxDir, `.commit_msg_${Date.now()}`);
      await fs.writeFile(msgFile, input.message, 'utf-8');
      const commitRes = await runCommand(`git commit -F "${msgFile}"`, cwd, 10000, sessionId);
      await fs.unlink(msgFile).catch(() => {});

      if (commitRes.exitCode !== 0) return formatError(new Error(`git commit failed: ${commitRes.stderr}`));

      const pushRes = await runCommand(`git push origin ${branch}`, cwd, 25000, sessionId);
      return formatOptimizedResponse({
        message: input.message,
        success: pushRes.exitCode === 0,
        output: pushRes.stdout || pushRes.stderr
      });
    } catch (err: any) {
      return formatError(err);
    }
  });
}

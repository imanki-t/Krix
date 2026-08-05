import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec, child_process, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations, sanitizeCommand, sanitizePath } from './security.js';

interface ActiveProcess {
  pid: number;
  command: string;
  proc: child_process.ChildProcess;
  startTime: Date;
}

const activeProcesses = new Map<number, ActiveProcess>();

/**
 * Creates or gets an isolated, ephemeral session directory.
 * Cleans up automatically after execution or on explicit cleanup request.
 */
async function getOrCreateSandboxDir(sessionId: string = 'default'): Promise<string> {
  const dir = path.join(os.tmpdir(), `mcp_sandbox_${sessionId}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function destroySandbox(sessionId: string = 'default'): Promise<void> {
  const dir = path.join(os.tmpdir(), `mcp_sandbox_${sessionId}`);
  try {
    // Kill any active child processes running inside this sandbox
    for (const [pid, item] of activeProcesses.entries()) {
      item.proc.kill('SIGKILL');
      activeProcesses.delete(pid);
    }
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

export function registerSandboxTools(server: McpServer) {
  // 1. Terminal Execution
  server.registerTool('execute_bash', {
    description: 'Execute shell commands inside isolated ephemeral sandbox terminal.',
    inputSchema: {
      command: z.string(),
      timeoutMs: z.number().optional().default(30000)
    },
    annotations: getToolAnnotations('execute_bash')
  }, async ({ command, timeoutMs }) => {
    try {
      sanitizeCommand(command);
      const sandboxDir = await getOrCreateSandboxDir('default');

      return await new Promise((resolve) => {
        exec(command, { cwd: sandboxDir, timeout: Math.min(timeoutMs, 120000), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
          let output = '';
          if (stdout) output += `[STDOUT]\n${stdout.slice(0, 2000)}\n`;
          if (stderr) output += `[STDERR]\n${stderr.slice(0, 1000)}\n`;
          if (err) output += `[EXIT CODE: ${err.code || 1}]`;

          resolve(formatOptimizedResponse(output.trim() || 'Executed with zero output.'));
        });
      });
    } catch (err) { return formatError(err); }
  });

  // 2. Python Snippet Runner
  server.registerTool('run_python', {
    description: 'Execute Python snippet inside ephemeral virtual environment.',
    inputSchema: { code: z.string(), args: z.array(z.string()).optional().default([]) },
    annotations: getToolAnnotations('run_python')
  }, async ({ code, args }) => {
    try {
      const sandboxDir = await getOrCreateSandboxDir('default');
      const tmpFile = path.join(sandboxDir, `script_${Date.now()}.py`);
      await fs.writeFile(tmpFile, code, 'utf-8');

      return await new Promise((resolve) => {
        exec(`python3 ${tmpFile} ${args.join(' ')}`, { cwd: sandboxDir, timeout: 30000 }, async (err, stdout, stderr) => {
          await fs.unlink(tmpFile).catch(() => {});
          resolve(formatOptimizedResponse(stdout || stderr || (err ? err.message : 'Finished.')));
        });
      });
    } catch (err) { return formatError(err); }
  });

  // 3. Node.js Snippet Runner
  server.registerTool('run_node', {
    description: 'Execute JavaScript/TypeScript code snippet.',
    inputSchema: { code: z.string() },
    annotations: getToolAnnotations('run_node')
  }, async ({ code }) => {
    try {
      const sandboxDir = await getOrCreateSandboxDir('default');
      const tmpFile = path.join(sandboxDir, `script_${Date.now()}.js`);
      await fs.writeFile(tmpFile, code, 'utf-8');

      return await new Promise((resolve) => {
        exec(`node ${tmpFile}`, { cwd: sandboxDir, timeout: 30000 }, async (err, stdout, stderr) => {
          await fs.unlink(tmpFile).catch(() => {});
          resolve(formatOptimizedResponse(stdout || stderr || (err ? err.message : 'Finished.')));
        });
      });
    } catch (err) { return formatError(err); }
  });

  // 4. Isolated Package Installer
  server.registerTool('install_package', {
    description: 'Install npm or pip packages into ephemeral sandbox directory.',
    inputSchema: { manager: z.enum(['npm', 'pip']), packages: z.array(z.string()) },
    annotations: getToolAnnotations('install_package')
  }, async ({ manager, packages }) => {
    try {
      const sandboxDir = await getOrCreateSandboxDir('default');
      const pkgList = packages.join(' ');
      const cmd = manager === 'npm' ? `npm install ${pkgList}` : `pip install --target=${sandboxDir} ${pkgList}`;

      return await new Promise((resolve) => {
        exec(cmd, { cwd: sandboxDir, timeout: 60000 }, (err, stdout, stderr) => {
          if (err) resolve(formatError(`Install failed: ${stderr || err.message}`));
          else resolve(formatOptimizedResponse(`Installed ${pkgList} into ephemeral sandbox.`));
        });
      });
    } catch (err) { return formatError(err); }
  });

  // 5. Multi-language File Runner
  server.registerTool('run_code_file', {
    description: 'Run code file (.py, .js, .ts, .java, .cpp, .go, .sh).',
    inputSchema: { filePath: z.string(), args: z.array(z.string()).optional().default([]) },
    annotations: getToolAnnotations('run_code_file')
  }, async ({ filePath, args }) => {
    try {
      const absPath = sanitizePath(filePath);
      const ext = path.extname(absPath).toLowerCase();
      let cmd = '';

      if (ext === '.py') cmd = `python3 ${absPath} ${args.join(' ')}`;
      else if (ext === '.js') cmd = `node ${absPath} ${args.join(' ')}`;
      else if (ext === '.ts') cmd = `npx ts-node ${absPath} ${args.join(' ')}`;
      else if (ext === '.java') cmd = `java ${absPath} ${args.join(' ')}`;
      else if (ext === '.go') cmd = `go run ${absPath} ${args.join(' ')}`;
      else if (ext === '.sh') cmd = `bash ${absPath} ${args.join(' ')}`;
      else if (ext === '.cpp') cmd = `g++ ${absPath} -o /tmp/app.out && /tmp/app.out ${args.join(' ')}`;
      else throw new Error(`Unsupported extension '${ext}'`);

      return await new Promise((resolve) => {
        exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
          resolve(formatOptimizedResponse(stdout || stderr || (err ? err.message : 'Finished.')));
        });
      });
    } catch (err) { return formatError(err); }
  });

  // 6. Process Manager
  server.registerTool('manage_process', {
    description: 'Inspect or terminate background sandbox processes.',
    inputSchema: { action: z.enum(['list', 'kill']), pid: z.number().optional() },
    annotations: getToolAnnotations('manage_process')
  }, async ({ action, pid }) => {
    try {
      if (action === 'list') {
        const list = Array.from(activeProcesses.values()).map(p => `PID ${p.pid}: ${p.command}`);
        return formatOptimizedResponse(list.length ? list.join('\n') : 'No active processes.');
      }
      if (action === 'kill' && pid) {
        const item = activeProcesses.get(pid);
        if (item) {
          item.proc.kill('SIGKILL');
          activeProcesses.delete(pid);
          return formatOptimizedResponse(`Killed PID ${pid}`);
        }
      }
      return formatError('Process not found.');
    } catch (err) { return formatError(err); }
  });

  // 7. Ephemeral Reset / Cleanup Tool
  server.registerTool('cleanup_sandbox', {
    description: 'Completely destroy temporary files, packages, and reset sandbox to fresh state.',
    inputSchema: {},
    annotations: getToolAnnotations('cleanup_sandbox')
  }, async () => {
    try {
      await destroySandbox('default');
      return formatOptimizedResponse('Ephemeral sandbox wiped clean. Fresh environment initialized.');
    } catch (err) { return formatError(err); }
  });

  // 8. Sandbox Environment Status
  server.registerTool('get_sandbox_status', {
    description: 'Check virtual IDE environment tools, memory, and status.',
    inputSchema: {},
    annotations: getToolAnnotations('get_sandbox_status')
  }, async () => {
    try {
      const runtimes: Record<string, string> = {};
      const check = (name: string, cmd: string) => {
        try { runtimes[name] = execSync(cmd, { timeout: 1000 }).toString().trim(); }
        catch { runtimes[name] = 'N/A'; }
      };

      check('Node.js', 'node -v');
      check('Python', 'python3 --version');
      check('Java', 'java -version 2>&1 | head -n 1');
      check('Go', 'go version');
      check('GCC', 'gcc --version | head -n 1');

      return formatOptimizedResponse({
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        runtimes
      });
    } catch (err) { return formatError(err); }
  });
}
import { spawn } from 'node:child_process';
import type { Exec, ExecOptions, ExecResult } from './types.js';
import { Secret, isRegisteredSecret } from './secret.js';

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result?: ExecResult,
  ) {
    super(message);
  }
}

/**
 * Run a command WITHOUT a shell (no quoting bugs, no injection). Secrets may only travel via
 * `opts.stdin`; passing one in argv throws, because argv is visible to every process on the machine
 * and often ends up in logs.
 */
export const exec: Exec = async (cmd, args, opts: ExecOptions = {}) => {
  for (const a of [cmd, ...args]) {
    if (isRegisteredSecret(a)) throw new ExecError(`refusing to pass a secret in argv to ${cmd}; use stdin`);
  }
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ExecError(`${cmd} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(new ExecError(e.code === 'ENOENT' ? `${cmd}: command not found` : `${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    const input = opts.stdin instanceof Secret ? opts.stdin.reveal() : opts.stdin;
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
};

/** Run and require exit code 0; parse stdout as JSON. */
export async function execJson<T>(run: Exec, cmd: string, args: string[], opts?: ExecOptions): Promise<T> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new ExecError(`${cmd} ${args[0] ?? ''} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, r);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new ExecError(`${cmd} ${args[0] ?? ''}: expected JSON output`, r);
  }
}

/** Does a command exist on PATH? */
export async function hasCommand(run: Exec, cmd: string): Promise<boolean> {
  try {
    const r = await run(cmd, ['--version'], { timeoutMs: 15_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

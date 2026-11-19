import { spawnSync } from 'node:child_process';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type Exec = (bin: string, args: string[], cwd: string) => ExecResult;

export const EXEC_TIMEOUT_MS = 30000;

export const defaultExec: Exec = (bin, args, cwd) => {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message };
};

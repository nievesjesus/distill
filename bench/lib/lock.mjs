import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        holder = Number.NaN;
      }
      if (alive(holder)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

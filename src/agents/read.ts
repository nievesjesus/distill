import { readIfExists } from '../hooks/atomic';

export function readText(path: string): string | null {
  try {
    return readIfExists(path);
  } catch {
    return null;
  }
}

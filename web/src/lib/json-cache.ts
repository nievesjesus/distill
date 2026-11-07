import { getJson } from '../api';

const results = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function cachedJson(serverId: string): string | undefined {
  return results.get(serverId);
}

export function clearJsonCache(): void {
  results.clear();
  inflight.clear();
}

export function forgetJson(serverId: string): void {
  results.delete(serverId);
  inflight.delete(serverId);
}

export function loadJson(serverId: string): Promise<string> {
  const cached = results.get(serverId);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(serverId);
  if (pending) return pending;
  const request = getJson(serverId).then(
    (value) => {
      const text = JSON.stringify(value, null, 2);
      results.set(serverId, text);
      inflight.delete(serverId);
      return text;
    },
    (error: unknown) => {
      inflight.delete(serverId);
      throw error;
    },
  );
  inflight.set(serverId, request);
  return request;
}

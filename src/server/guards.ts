import { isIP } from 'node:net';
import { isLoopbackHost } from '../core/loopback';

const DEFAULT_PORT_BY_PROTOCOL: Readonly<Record<string, string>> = { 'http:': ':80', 'https:': ':443' };

export function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0]?.toLowerCase() ?? '';
}

export function originHostname(origin: string): string | null {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname;
  } catch {
    return null;
  }
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}

export function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  if (hostname === '') return false;
  if (isLoopbackHost(hostname) || isIpLiteral(hostname)) return true;
  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    if (allowed === '' || allowed === '.') return false;
    return allowed.startsWith('.') ? hostname === allowed.slice(1) || hostname.endsWith(allowed) : hostname === allowed;
  });
}

function withoutDefaultPort(hostHeader: string, protocol: string): string {
  const host = hostHeader.toLowerCase();
  const defaultPort = DEFAULT_PORT_BY_PROTOCOL[protocol];
  return defaultPort !== undefined && host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
}

export function isCrossSiteRequest(headers: { secFetchSite?: string; origin?: string; host?: string }): boolean {
  if (headers.secFetchSite?.toLowerCase() === 'cross-site') return true;
  if (headers.origin === undefined) return false;
  try {
    const url = new URL(headers.origin);
    return url.host.toLowerCase() !== withoutDefaultPort(headers.host ?? '', url.protocol);
  } catch {
    return true;
  }
}

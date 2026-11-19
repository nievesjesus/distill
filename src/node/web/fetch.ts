import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { type Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import robotsParser from 'robots-parser';
import { DistillError } from '../errors';

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_AGENT = 'distill-llm';
const SNIFF_BYTES = 4096;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const ACCEPT = 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8';

export interface TransportRequest {
  url: URL;
  addresses: string[];
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Readable;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (hostname: string) => Promise<string[]>;

export interface FetchOptions {
  allowPrivate?: boolean;
  allowHosts?: readonly string[];
  robotsPolicy?: 'ignore' | 'respect';
  timeoutMs?: number;
  maxBytes?: number;
  version?: string;
  etag?: string;
  lastModified?: string;
  resolve?: Resolver;
  transport?: Transport;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  markdownServed: boolean;
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
}

export function userAgentFor(version?: string): string {
  return `distill-llm${version ? `/${version}` : ''} (+https://github.com/nievesjesus/distill)`;
}

function isGlobalV4(address: ipaddr.IPv4): boolean {
  return address.range() === 'unicast';
}

function embeddedV4(high: number, low: number): ipaddr.IPv4 {
  return new ipaddr.IPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

export function isGlobalAddress(text: string): boolean {
  if (!ipaddr.isValid(text)) return false;
  const address = ipaddr.parse(text);
  if (address.kind() === 'ipv4') return isGlobalV4(address as ipaddr.IPv4);
  const v6 = address as ipaddr.IPv6;
  const p = v6.parts;
  if (v6.isIPv4MappedAddress()) return isGlobalV4(v6.toIPv4Address());
  if (p[0] === 0x64 && p[1] === 0xff9b) {
    return p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0 && isGlobalV4(embeddedV4(p[6] as number, p[7] as number));
  }
  if (p.slice(0, 6).every((part) => part === 0)) return false;
  if (p[0] === 0x2002) return isGlobalV4(embeddedV4(p[1] as number, p[2] as number));
  if (((p[0] as number) & 0xe000) !== 0x2000) return false;
  return v6.range() === 'unicast';
}

const systemResolve: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const flattenHeaders = (headers: IncomingHttpHeaders): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));

const bareHost = (url: URL): string => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);

export const defaultTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const list = request.addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const first = list[0] as { address: string; family: number };
      if (options.all) (callback as unknown as (error: null, addresses: typeof list) => void)(null, list);
      else callback(null, first.address, first.family);
    };
    const make = request.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = make(
      {
        hostname: bareHost(request.url),
        port: request.url.port === '' ? undefined : Number(request.url.port),
        path: `${request.url.pathname}${request.url.search}`,
        method: 'GET',
        headers: request.headers,
        lookup,
        signal: request.signal,
        agent: false,
      },
      (response) => resolve({ status: response.statusCode ?? 0, headers: flattenHeaders(response.headers), body: response }),
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

interface Context {
  allowPrivate: boolean;
  allowHosts: ReadonlySet<string>;
  robotsPolicy: 'ignore' | 'respect';
  timeoutMs: number;
  maxBytes: number;
  version?: string;
  resolve: Resolver;
  transport: Transport;
  signal: AbortSignal;
  robots: Map<string, ReturnType<typeof robotsParser> | 'disallow-all' | 'none'>;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DistillError('bad_request', 'Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DistillError('bad_request', 'Only http and https URLs are supported');
  }
  if (url.username !== '' || url.password !== '') throw new DistillError('bad_request', 'URLs with credentials are not allowed');
  if (url.hostname === '') throw new DistillError('bad_request', 'Not a valid URL');
  url.hash = '';
  return url;
}

const refused = (host: string): DistillError =>
  new DistillError('forbidden', `Refused: ${host} is a private, loopback or link-local address, and distill only fetches public web pages`);

async function vettedAddresses(url: URL, ctx: Context): Promise<string[]> {
  const literal = bareHost(url);
  const host = literal.toLowerCase();
  const trusted = ctx.allowPrivate || ctx.allowHosts.has(host);
  if (!trusted && (host === 'localhost' || host.endsWith('.localhost'))) throw refused(host);
  let addresses: string[];
  if (ipaddr.isValid(literal)) addresses = [literal];
  else {
    try {
      addresses = await ctx.resolve(literal);
    } catch (error) {
      throw new DistillError('fetch_failed', `Could not resolve ${host}`, { cause: error });
    }
  }
  if (addresses.length === 0) throw new DistillError('fetch_failed', `Could not resolve ${host}`);
  if (!trusted && !addresses.every(isGlobalAddress)) throw refused(host);
  return addresses;
}

function decoderFor(encoding: string): ReturnType<typeof createGunzip> | null {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    case 'identity':
    case '':
      return null;
    default:
      throw new DistillError('fetch_failed', `Unsupported content encoding: ${encoding}`);
  }
}

async function readBody(response: TransportResponse, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const encodings = (response.headers['content-encoding'] ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .reverse();
  const decoders = encodings.map(decoderFor).filter((decoder) => decoder !== null);
  const stages = [response.body, ...decoders] as [Readable, ...Readable[]];
  const output: Readable = decoders.length === 0 ? response.body : (pipeline(stages, () => {}) as unknown as Readable);
  const onAbort = (): void => {
    response.body.destroy();
    output.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of output) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        throw new DistillError('too_large', `The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB once decompressed`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof DistillError || signal.aborted) throw error;
    throw new DistillError('fetch_failed', 'The response could not be decoded', { cause: error });
  } finally {
    signal.removeEventListener('abort', onAbort);
    response.body.destroy();
    output.destroy();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

interface Hop {
  finalUrl: URL;
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

async function robotsFor(url: URL, ctx: Context): Promise<void> {
  if (ctx.robotsPolicy !== 'respect') return;
  let entry = ctx.robots.get(url.origin);
  if (entry === undefined) {
    entry = 'none';
    try {
      const hop = await request(new URL('/robots.txt', url.origin), ctx, { maxBytes: ROBOTS_MAX_BYTES, robots: false });
      if (hop.status >= 500) entry = 'disallow-all';
      else if (hop.status >= 200 && hop.status < 300) entry = robotsParser(`${url.origin}/robots.txt`, decodeText(hop.body, hop.headers['content-type']));
    } catch (error) {
      if (error instanceof DistillError && error.code === 'timeout') throw error;
    }
    ctx.robots.set(url.origin, entry);
  }
  const blocked = entry === 'disallow-all' || (entry !== 'none' && entry.isAllowed(url.href, ROBOTS_AGENT) === false);
  if (blocked) throw new DistillError('forbidden', `Refused: robots.txt on ${url.host} disallows fetching this page`);
}

async function request(
  start: URL,
  ctx: Context,
  opts: { maxBytes: number; robots: boolean; etag?: string; lastModified?: string },
): Promise<Hop> {
  let url = start;
  for (let hops = 0; ; hops++) {
    if (opts.robots) await robotsFor(url, ctx);
    const addresses = await vettedAddresses(url, ctx);
    const headers: Record<string, string> = {
      accept: ACCEPT,
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': userAgentFor(ctx.version),
    };
    if (hops === 0 && opts.etag) headers['if-none-match'] = opts.etag;
    if (hops === 0 && opts.lastModified) headers['if-modified-since'] = opts.lastModified;
    const response = await ctx.transport({ url, addresses, headers, signal: ctx.signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      response.body.destroy();
      const location = response.headers.location;
      if (!location) throw new DistillError('fetch_failed', `The server redirected (HTTP ${response.status}) without a location`);
      if (hops >= MAX_REDIRECTS) throw new DistillError('fetch_failed', `Too many redirects (more than ${MAX_REDIRECTS})`);
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new DistillError('fetch_failed', 'The server redirected to an invalid URL');
      }
      url = parseUrl(next);
      continue;
    }
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      response.body.destroy();
      throw new DistillError('too_large', `The page is larger than ${Math.round(opts.maxBytes / (1024 * 1024))} MB`);
    }
    if (response.status === 304) {
      response.body.destroy();
      return { finalUrl: url, status: 304, headers: response.headers, body: new Uint8Array() };
    }
    const body = await readBody(response, opts.maxBytes, ctx.signal);
    return { finalUrl: url, status: response.status, headers: response.headers, body };
  }
}

function normalize(error: unknown, ctx: Context): DistillError {
  if (error instanceof DistillError) return error;
  if (ctx.signal.aborted) {
    return new DistillError('timeout', `Timed out after ${Math.round(ctx.timeoutMs / 1000)} s fetching the page`, { cause: error });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new DistillError('fetch_failed', `Could not fetch the page: ${reason.slice(0, 160)}`, { cause: error });
}

export async function fetchUrl(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx: Context = {
    allowPrivate: options.allowPrivate ?? false,
    allowHosts: new Set((options.allowHosts ?? []).map((host) => host.toLowerCase())),
    robotsPolicy: options.robotsPolicy ?? 'respect',
    timeoutMs,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    ...(options.version ? { version: options.version } : {}),
    resolve: options.resolve ?? systemResolve,
    transport: options.transport ?? defaultTransport,
    signal: controller.signal,
    robots: new Map(),
  };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = parseUrl(input);
    const hop = await request(url, ctx, {
      maxBytes: ctx.maxBytes,
      robots: true,
      ...(options.etag ? { etag: options.etag } : {}),
      ...(options.lastModified ? { lastModified: options.lastModified } : {}),
    });
    if (hop.status === 404 || hop.status === 410) throw new DistillError('not_found', `The page was not found (HTTP ${hop.status})`);
    if (hop.status !== 304 && (hop.status < 200 || hop.status >= 300)) {
      throw new DistillError('fetch_failed', `The server answered HTTP ${hop.status}`);
    }
    const contentType = hop.headers['content-type'] ?? '';
    const { etag, 'last-modified': lastModified, 'cache-control': cacheControl } = hop.headers;
    return {
      finalUrl: hop.finalUrl.href,
      status: hop.status,
      contentType,
      body: hop.body,
      markdownServed: /^\s*text\/(x-)?markdown\b/i.test(contentType),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(cacheControl ? { cacheControl } : {}),
    };
  } catch (error) {
    throw normalize(error, ctx);
  } finally {
    clearTimeout(timer);
  }
}

function supported(label: string | undefined): string | null {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}

function bomEncoding(body: Uint8Array): string | null {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return null;
}

export function decodeText(body: Uint8Array, contentType: string | undefined): string {
  const fromBom = bomEncoding(body);
  const fromHeader = supported(/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1]);
  const head = Buffer.from(body.subarray(0, SNIFF_BYTES)).toString('latin1');
  const fromMeta = supported(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1]);
  const encoding = fromBom ?? fromHeader ?? fromMeta ?? 'utf-8';
  return new TextDecoder(encoding).decode(body);
}

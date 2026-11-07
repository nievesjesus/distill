import type { ApiError, Health, LinguaModel, ParseResponse } from '@core/types';
import { S } from './strings';

async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw { code: 'parse_failed', message: S.unreachable } satisfies ApiError;
  }
  if (response.ok) return response;
  throw await toApiError(response);
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (isApiError(body)) return body;
  } catch {
    return { code: 'parse_failed', message: S.unexpectedResponse(response.status) };
  }
  return { code: 'parse_failed', message: S.unexpectedResponse(response.status) };
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).code === 'string' &&
    typeof (value as ApiError).message === 'string'
  );
}

export async function getHealth(): Promise<Health> {
  return (await request('/api/health')).json();
}

export async function parseFile(file: File, signal?: AbortSignal): Promise<ParseResponse> {
  const form = new FormData();
  form.append('file', file);
  return (await request('/api/parse', { method: 'POST', body: form, signal })).json();
}

export async function getJson(id: string): Promise<unknown> {
  return (await request(`/api/files/${encodeURIComponent(id)}/json`)).json();
}

export async function compress(text: string, rate: number, model: LinguaModel, signal?: AbortSignal): Promise<string> {
  const response = await request('/api/compress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, rate, model }),
    signal,
  });
  const body: { text: string } = await response.json();
  return body.text;
}

export async function deleteFile(id: string): Promise<void> {
  await request(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

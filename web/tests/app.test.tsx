import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBoosterId } from '@core/types';
import { App } from '../src/App';

const distillMock = vi.hoisted(() => vi.fn());

vi.mock('../src/worker/client', () => ({ distill: distillMock }));

const RAW = 'x'.repeat(2000);

function stubServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/health') return Response.json({ version: '1', liteparseVersion: '1', libreoffice: false, maxBytes: 100000 });
      const name = ((init?.body as FormData).get('file') as File).name;
      return Response.json({ id: name, name, kind: 'PDF', pages: 1, markdown: RAW, ms: 1 });
    }),
  );
}

function drop(names: string[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const files = names.map((name) => new File(['x'], name));
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  localStorage.clear();
  distillMock.mockReset();
  distillMock.mockImplementation(async (raw: string, active: LocalBoosterId[]) => {
    const cut = active.length * 100;
    return { out: raw.slice(cut), rawTokens: raw.length, outTokens: raw.length - cut };
  });
  stubServer();
});

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows savings in the row and footer after distilling', async () => {
    render(<App />);
    drop(['a.pdf']);
    await waitFor(() => expect(screen.getByText('2.0k → 1.6k')).toBeInTheDocument());
    expect(screen.getByText('−20%', { selector: '.file-saved' })).toBeInTheDocument();
    expect(screen.getByText(/tokens · 2\.0k → 1\.6k · 1\/1 files/)).toBeInTheDocument();
  });

  it('optimize off shows equal raw and out counts and 0% in the footer', async () => {
    render(<App />);
    drop(['a.pdf']);
    await waitFor(() => expect(screen.getByText('2.0k → 1.6k')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('switch', { name: 'Optimize for LLMs' }));
    await waitFor(() => expect(screen.getByText(/tokens · 2\.0k → 2\.0k · 1\/1 files/)).toBeInTheDocument());
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('0%')).toBeInTheDocument();
  });

  it('expands the booster list from the summary button and toggles a booster', async () => {
    render(<App />);
    const summary = screen.getByRole('button', { name: '4 boosters' });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    const tables = screen.getByRole('switch', { name: 'Compact tables' });
    expect(tables).toHaveAttribute('aria-checked', 'true');
    expect(within(tables).getByText('−14%')).toBeInTheDocument();
    fireEvent.click(tables);
    expect(tables).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: '3 boosters' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').active).toEqual(['dedupe', 'media', 'ws']);
  });

  it('renders the lossy LLMLingua-2 row and only records its toggle', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '4 boosters' }));
    const lingua = screen.getByRole('switch', { name: 'LLMLingua-2' });
    expect(within(lingua).getByText('−45%')).toBeInTheDocument();
    fireEvent.click(lingua);
    expect(lingua).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').lingua.on).toBe(true);
  });

  it('shows a visible error for an unsupported file and still finishes the others', async () => {
    render(<App />);
    drop(['notes.xyz', 'a.pdf']);
    await waitFor(() => expect(screen.getByText('This file type is not supported.')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/1\/2 files/)).toBeInTheDocument());
  });

  it('shows an app-level line when health cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach distill'));
  });

  it('lifts Compact and Detailed into persisted settings', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }));
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').detailed).toBe(true);
    expect(screen.getByRole('button', { name: /\d boosters/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

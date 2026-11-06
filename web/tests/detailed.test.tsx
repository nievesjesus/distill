import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinguaStatus, LocalBoosterId } from '@core/types';
import { App } from '../src/App';
import { clearJsonCache } from '../src/components/Preview';

const distillMock = vi.hoisted(() => vi.fn());

vi.mock('../src/worker/client', () => ({ distill: distillMock }));

const RAW = 'x'.repeat(2000);
const LOSSLESS = 'x'.repeat(1600);

interface Server {
  lingua: LinguaStatus;
  compress: (body: { text: string; rate: number; model: string }) => Promise<Response> | Response;
  json: (id: string) => Promise<Response> | Response;
  healthCalls: number;
  compressCalls: { text: string; rate: number; model: string }[];
  jsonCalls: string[];
}

let server: Server;

const installed = (patch: Partial<LinguaStatus> = {}): LinguaStatus => ({
  installed: true,
  model: 'tinybert',
  state: 'ready',
  progress: 1,
  ...patch,
});

function stubServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/health') {
        server.healthCalls += 1;
        return Response.json({ version: '1', liteparseVersion: '1', libreoffice: true, maxBytes: 100000, lingua: server.lingua });
      }
      if (url === '/api/compress') {
        const body = JSON.parse(String(init?.body));
        server.compressCalls.push(body);
        return server.compress(body);
      }
      if (url.endsWith('/json')) {
        server.jsonCalls.push(url);
        return server.json(url);
      }
      const name = ((init?.body as FormData).get('file') as File).name;
      return Response.json({ id: `srv-${name}`, name, kind: 'PDF', pages: 1, markdown: RAW, ms: 1 });
    }),
  );
}

function drop(names: string[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map((name) => new File(['x'], name)) } });
}

function preset(settings: Record<string, unknown>) {
  localStorage.setItem('distill:settings', JSON.stringify(settings));
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferredCompress() {
  const resolvers: ((text: string) => void)[] = [];
  const compress = () =>
    new Promise<Response>((resolve) => {
      resolvers.push((text) => resolve(Response.json({ text })));
    });
  return { resolvers, compress };
}

async function openDetailedWithRow() {
  render(<App />);
  drop(['a.pdf']);
  await screen.findByRole('region', { name: 'Markdown preview of a.pdf' });
}

beforeEach(() => {
  localStorage.clear();
  clearJsonCache();
  distillMock.mockReset();
  distillMock.mockImplementation(async (raw: string, active: LocalBoosterId[]) => {
    const cut = active.length * 100;
    return { out: raw.slice(cut), rawTokens: raw.length, outTokens: raw.length - cut };
  });
  server = {
    lingua: installed(),
    compress: ({ text }) => Response.json({ text: text.slice(0, 5) }),
    json: () => Response.json({ page: 1 }),
    healthCalls: 0,
    compressCalls: [],
    jsonCalls: [],
  };
  stubServer();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Detailed view', () => {
  it('shows booster hints, savings bar and Markdown/JSON tabs', async () => {
    preset({ detailed: true, optionsOpen: true });
    await openDetailedWithRow();
    expect(screen.getByText(/running headers, page numbers/)).toBeInTheDocument();
    const detail = await screen.findByText('2,000 → 1,600 tokens (o200k)');
    expect(detail).toHaveAttribute('title', 'Counted with OpenAI o200k. Other models tokenize differently; the % saved is comparable.');
    expect(detail.getAttribute('aria-describedby')).toBeTruthy();
    const describedBy = document.getElementById(detail.getAttribute('aria-describedby') as string);
    expect(describedBy).toHaveTextContent('Counted with OpenAI o200k.');
    const fill = document.querySelector('.savings-fill') as HTMLElement;
    expect(fill.style.width).toBe('80%');
    const tablist = screen.getByRole('tablist');
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Markdown', 'JSON + boxes']);
    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'true');
  });

  it('hides the Detailed extras in Compact', async () => {
    await openDetailedWithRow();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(/o200k/)).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
  });

  it('JSON tab fetches /api/files/:id/json once and caches it', async () => {
    preset({ detailed: true, optionsOpen: true });
    await openDetailedWithRow();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON + boxes' }));
    expect(await screen.findByText('Loading JSON…')).toBeInTheDocument();
    const region = await screen.findByRole('region', { name: 'JSON preview of a.pdf' });
    await waitFor(() => expect(region).toHaveTextContent('"page": 1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }));
    fireEvent.click(screen.getByRole('tab', { name: 'JSON + boxes' }));
    expect(await screen.findByRole('region', { name: 'JSON preview of a.pdf' })).toHaveTextContent('"page": 1');
    expect(server.jsonCalls).toEqual(['/api/files/srv-a.pdf/json']);
  });

  it('shows a mapped JSON error with Retry that fetches again', async () => {
    preset({ detailed: true, optionsOpen: true });
    server.json = () => Response.json({ code: 'not_found', message: 'gone' }, { status: 404 });
    await openDetailedWithRow();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON + boxes' }));
    expect(await screen.findByText('This file is no longer available. Drop it again.')).toBeInTheDocument();
    server.json = () => Response.json({ page: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'JSON preview of a.pdf' })).toHaveTextContent('"page": 2'));
    expect(server.jsonCalls).toHaveLength(2);
  });

  it('truncates JSON over 2,000,000 chars and offers a .json download', async () => {
    preset({ detailed: true, optionsOpen: true });
    server.json = () => Response.json({ blob: 'y'.repeat(2_100_000) });
    await openDetailedWithRow();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON + boxes' }));
    const region = await screen.findByRole('region', { name: 'JSON preview of a.pdf' }, { timeout: 5000 });
    await waitFor(() => expect(region.textContent?.endsWith('… (truncated, download for full JSON)')).toBe(true), { timeout: 5000 });
    expect(region.textContent?.length).toBe(2_000_000 + '… (truncated, download for full JSON)'.length);
    expect(screen.getByRole('button', { name: 'Download .json' })).toBeInTheDocument();
  });

  it('switches tabs with ArrowRight and ArrowLeft', async () => {
    preset({ detailed: true, optionsOpen: true });
    await openDetailedWithRow();
    const markdown = screen.getByRole('tab', { name: 'Markdown' });
    const json = screen.getByRole('tab', { name: 'JSON + boxes' });
    markdown.focus();
    fireEvent.keyDown(markdown, { key: 'ArrowRight' });
    expect(json).toHaveAttribute('aria-selected', 'true');
    expect(json).toHaveFocus();
    expect(json).toHaveAttribute('tabindex', '0');
    expect(markdown).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(json, { key: 'ArrowLeft' });
    expect(markdown).toHaveAttribute('aria-selected', 'true');
    expect(markdown).toHaveFocus();
    expect(markdown.getAttribute('aria-controls')).toBe(screen.getByRole('region', { name: 'Markdown preview of a.pdf' }).id);
  });

  it('shows a model select and a rate slider only in Detailed', async () => {
    preset({ detailed: true, optionsOpen: true });
    render(<App />);
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['tinybert', 'TinyBERT · 57 MB'],
      ['mobilebert', 'MobileBERT · 99 MB'],
      ['xlm-roberta', 'XLM-RoBERTa · 2.2 GB'],
    ]);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['0.3', '0.9', '0.05', '0.6']);
    expect(slider).toHaveAttribute('aria-valuetext', 'keep 60%');
    expect(screen.getByText('keep 60%')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'mobilebert' } });
    fireEvent.change(slider, { target: { value: '0.75' } });
    const stored = JSON.parse(localStorage.getItem('distill:settings') ?? '{}');
    expect(stored.lingua).toMatchObject({ model: 'mobilebert', rate: 0.75 });
    expect(screen.getByText('keep 75%')).toBeInTheDocument();
  });
});

describe('LLMLingua-2', () => {
  it('is disabled with "not installed" when health.lingua.installed=false and never turns on', async () => {
    preset({ detailed: true, optionsOpen: true });
    server.lingua = installed({ installed: false, state: 'idle', progress: 0 });
    render(<App />);
    const lingua = await screen.findByRole('switch', { name: /LLMLingua-2/ });
    await waitFor(() => expect(lingua).toBeDisabled());
    expect(lingua).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/not installed/)).toBeInTheDocument();
    expect(screen.getByText('Run with the full package or Docker image to enable')).toBeInTheDocument();
    fireEvent.click(lingua);
    expect(lingua).toHaveAttribute('aria-checked', 'false');
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').lingua.on).toBe(false);
  });

  it('calls compress on the local booster output and shows the lossy note', async () => {
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    await openDetailedWithRow();
    await waitFor(() => expect(server.compressCalls).toHaveLength(1));
    expect(server.compressCalls[0]).toEqual({ text: LOSSLESS, rate: 0.6, model: 'tinybert' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' })).toHaveTextContent('xxxxx'));
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' }).textContent).toBe('xxxxx');
    expect(screen.getByText('2.0k → 5')).toBeInTheDocument();
    expect(screen.getByText(/Lossy: a local model removes low-value words/)).toBeInTheDocument();
    expect(distillMock).toHaveBeenCalledWith('xxxxx', []);
  });

  it('does not compress when optimize is off or the model is not installed', async () => {
    preset({ optimize: false, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    await openDetailedWithRow();
    await waitFor(() => expect(screen.getByText(/tokens · 2\.0k → 2\.0k/)).toBeInTheDocument());
    expect(server.compressCalls).toHaveLength(0);
  });

  it('shows "compressing…" while pending and keeps previous counts', async () => {
    preset({ lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    const pending = deferredCompress();
    server.compress = pending.compress;
    await openDetailedWithRow();
    expect(await screen.findByText('compressing…')).toBeInTheDocument();
    expect(screen.getByText('2.0k → 1.6k')).toBeInTheDocument();
    await act(async () => pending.resolvers[0]('short'));
    await waitFor(() => expect(screen.queryByText('compressing…')).toBeNull());
  });

  it('debounces rate changes by 400ms and ignores stale compress results', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ detailed: true, optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    const pending = deferredCompress();
    server.compress = pending.compress;
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    await flush();
    expect(server.compressCalls.map((call) => call.rate)).toEqual([0.6]);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '0.7' } });
    await advance(399);
    expect(server.compressCalls).toHaveLength(1);
    await advance(1);
    expect(server.compressCalls.map((call) => call.rate)).toEqual([0.6, 0.7]);
    await act(async () => pending.resolvers[1]('fresh'));
    await act(async () => pending.resolvers[0]('stale'));
    await flush();
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' })).toHaveTextContent('fresh');
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' })).not.toHaveTextContent('stale');
  });

  it('reuses cached compressed output when the rate returns to a previous value', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ detailed: true, optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    await flush();
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '0.7' } });
    await advance(400);
    fireEvent.change(slider, { target: { value: '0.6' } });
    await advance(400);
    expect(server.compressCalls.map((call) => call.rate)).toEqual([0.6, 0.7]);
  });

  it('keeps the row done with lossless output on compress failure and announces once', async () => {
    preset({ lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.compress = () => Response.json({ code: 'lingua_unavailable', message: 'nope' }, { status: 503 });
    await openDetailedWithRow();
    const message = 'LLMLingua-2 failed — showing lossless output';
    const inline = () => [...document.querySelectorAll('.lingua-line')].filter((node) => node.textContent === message);
    await waitFor(() => expect(inline()).toHaveLength(1));
    const announcer = document.querySelector('[role=status]') as HTMLElement;
    await waitFor(() => expect(announcer).toHaveTextContent(message));
    expect(document.querySelector('.file')).toHaveAttribute('data-status', 'done');
    expect(screen.getByRole('region', { name: 'Markdown preview of a.pdf' }).textContent).toBe(LOSSLESS);
    expect(inline()).toHaveLength(1);
    expect(document.querySelectorAll('[role=status]')).toHaveLength(1);
  });
});

describe('LLMLingua-2 model download', () => {
  it('polls /api/health every second until ready and announces completion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.lingua = installed({ state: 'downloading', progress: 0.42 });
    render(<App />);
    await flush();
    expect(screen.getByText('Downloading model 42%')).toBeInTheDocument();
    expect(server.healthCalls).toBe(1);
    await advance(1000);
    expect(server.healthCalls).toBe(2);
    server.lingua = installed({ state: 'ready', progress: 1 });
    await advance(1000);
    expect(server.healthCalls).toBe(3);
    expect(screen.queryByText(/Downloading model/)).toBeNull();
    const announcer = document.querySelector('[role=status]') as HTMLElement;
    await advance(100);
    expect(announcer).toHaveTextContent('LLMLingua-2 model ready');
    await advance(5000);
    expect(server.healthCalls).toBe(3);
  });

  it('never polls when idle and lingua is off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    server.lingua = installed({ state: 'idle', progress: 0 });
    render(<App />);
    await flush();
    await advance(5000);
    expect(server.healthCalls).toBe(1);
  });

  it('starts polling after the first compress request when state is idle, and stops at ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.lingua = installed({ state: 'idle', progress: 0 });
    const pending = deferredCompress();
    server.compress = pending.compress;
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    await flush();
    expect(server.compressCalls).toHaveLength(1);
    await advance(1000);
    expect(server.healthCalls).toBe(2);
    server.lingua = installed({ state: 'ready', progress: 1 });
    await advance(1000);
    expect(server.healthCalls).toBe(3);
    await advance(5000);
    expect(server.healthCalls).toBe(3);
  });

  it('shows the download error with a Retry that requests compression again', async () => {
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.lingua = installed({ state: 'error', progress: 0 });
    render(<App />);
    expect(await screen.findByText('Model download failed — check your connection and try again')).toBeInTheDocument();
    drop(['a.pdf']);
    await waitFor(() => expect(server.compressCalls).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(server.compressCalls).toHaveLength(2));
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinguaStatus, LocalBoosterId } from '@core/types';
import { App } from '../src/App';
import { clearJsonCache } from '../src/components/Preview';

const distillMock = vi.hoisted(() => vi.fn());

vi.mock('../src/worker/client', () => ({ distill: distillMock, forgetRaw: vi.fn() }));

const RAW = 'x'.repeat(2000);
const LOSSLESS = 'x'.repeat(1600);

interface Server {
  lingua: LinguaStatus;
  compress: (body: { text: string; rate: number; model: string }) => Promise<Response> | Response;
  json: (id: string) => Promise<Response> | Response;
  healthCalls: number;
  installCalls: number;
  compressCalls: { text: string; rate: number; model: string }[];
  jsonCalls: string[];
  signals: (AbortSignal | null | undefined)[];
}

let server: Server;

const installed = (patch: Partial<LinguaStatus> = {}): LinguaStatus => ({
  installed: true,
  installable: true,
  model: 'tinybert',
  state: 'ready',
  progress: 1,
  ...patch,
});

function stubServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/update') return new Response(null, { status: 404 });
      if (url === '/api/health') {
        server.healthCalls += 1;
        return Response.json({ version: '1', liteparseVersion: '1', libreoffice: true, maxBytes: 100000, lingua: server.lingua });
      }
      if (url === '/api/lingua/install') {
        server.installCalls += 1;
        server.lingua = installed({ installed: false, state: 'installing', progress: 0 });
        return Response.json(server.lingua, { status: 202 });
      }
      if (url === '/api/compress') {
        const body = JSON.parse(String(init?.body));
        server.compressCalls.push(body);
        server.signals.push(init?.signal);
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
    installCalls: 0,
    compressCalls: [],
    jsonCalls: [],
    signals: [],
  };
  stubServer();
});

afterEach(() => {
  delete document.documentElement.dataset.shell;
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

  it('compresses once after the debounce when boosters are toggled three times quickly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    await flush();
    expect(server.compressCalls).toHaveLength(1);
    for (const name of ['Compact tables', 'Collapse whitespace', 'Slim images and links']) {
      fireEvent.click(screen.getByRole('switch', { name }));
      await advance(50);
    }
    expect(server.compressCalls).toHaveLength(1);
    await advance(400);
    expect(server.compressCalls).toHaveLength(2);
    await advance(2000);
    expect(server.compressCalls).toHaveLength(2);
  });

  it('aborts the previous compress request when its ticket goes stale and shows no failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ detailed: true, optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.compress = () => new Promise<Response>(() => undefined);
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    await flush();
    const first = server.signals[0] as AbortSignal;
    expect(first.aborted).toBe(false);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.7' } });
    await advance(400);
    expect(first.aborted).toBe(true);
    expect(server.signals[1]?.aborted).toBe(false);
    expect(screen.queryByText('LLMLingua-2 failed — showing lossless output')).toBeNull();
  });

  it('shows lingua as off when persisted on but not installed', async () => {
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.lingua = installed({ installed: false, state: 'idle', progress: 0 });
    render(<App />);
    expect(await screen.findByRole('button', { name: '4 boosters' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /LLMLingua-2/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/Lossy: a local model/)).toBeNull();
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').lingua.on).toBe(true);
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

describe('LLMLingua-2 on-demand install', () => {
  const notInstalled = (patch: Partial<LinguaStatus> = {}) => installed({ installed: false, state: 'idle', progress: 0, ...patch });

  it('offers an install button with the size and a privacy note when installable', async () => {
    preset({ optionsOpen: true });
    server.lingua = notInstalled();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Install (~520 MB)' })).toBeInTheDocument();
    expect(screen.getByText(/downloaded from npm once.*model.*57 MB.*hugging face.*first time.*offline/i)).toBeInTheDocument();
    expect(screen.queryByText('Available in distill full')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('installs on click, shows an indeterminate progress, then moves on to the model download', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ optionsOpen: true });
    server.lingua = notInstalled();
    render(<App />);
    await flush();
    drop(['a.pdf']);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Install (~520 MB)' }));
    await flush();
    expect(server.installCalls).toBe(1);
    expect(JSON.parse(localStorage.getItem('distill:settings') ?? '{}').lingua.on).toBe(true);
    const bar = screen.getByRole('progressbar', { name: 'Installing…' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByRole('button', { name: 'Install (~520 MB)' })).toBeNull();
    expect(screen.getByRole('switch', { name: /LLMLingua-2/ })).toBeDisabled();
    await advance(1000);
    expect(screen.getByRole('progressbar', { name: 'Installing…' })).toBeInTheDocument();
    server.lingua = installed({ state: 'idle', progress: 0 });
    await advance(1000);
    await flush();
    expect(screen.queryByRole('progressbar', { name: 'Installing…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install (~520 MB)' })).toBeNull();
    expect(server.compressCalls.length).toBeGreaterThan(0);
    await advance(100);
    const announcer = document.querySelector('[role=status]') as HTMLElement;
    expect(announcer).toHaveTextContent('LLMLingua-2 installed');
  });

  it('shows the install progress without a button when an installation is already running', async () => {
    preset({ optionsOpen: true });
    server.lingua = notInstalled({ state: 'installing' });
    render(<App />);
    expect(await screen.findByRole('progressbar', { name: 'Installing…' })).toBeInTheDocument();
    expect(screen.getByText('Installing…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install (~520 MB)' })).toBeNull();
  });

  it('shows the failure with its message and lets the user retry', async () => {
    preset({ optionsOpen: true });
    server.lingua = notInstalled({ state: 'install_failed', installError: { code: 'npm_failed', message: 'network request failed' } });
    render(<App />);
    expect(await screen.findByText(/Install failed/)).toHaveTextContent('network request failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(server.installCalls).toBe(1));
  });

  it('announces an install failure once, through the alert only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    preset({ optionsOpen: true });
    server.lingua = notInstalled({ state: 'installing' });
    render(<App />);
    await flush();
    server.lingua = notInstalled({ state: 'install_failed', installError: { code: 'npm_failed', message: 'network request failed' } });
    await advance(1000);
    await flush();
    await advance(100);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Install failed: network request failed');
    const announcer = document.querySelector('[role=status]') as HTMLElement;
    expect(announcer).not.toHaveTextContent(/install/i);
  });

  it('explains that npm is missing, with a hint, outside the desktop shell', async () => {
    preset({ optionsOpen: true });
    server.lingua = notInstalled({ installable: false });
    render(<App />);
    expect(await screen.findByText(/npm was not found/i)).toBeInTheDocument();
    expect(screen.getByText(/install node\.js/i)).toBeInTheDocument();
    expect(screen.queryByText('Available in distill full')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Available in distill full' })).toBeNull();
    expect(screen.getByRole('switch', { name: /LLMLingua-2/ })).toBeDisabled();
  });

  it('points to distill full when the app cannot install (desktop lite)', async () => {
    document.documentElement.dataset.shell = 'desktop';
    preset({ optionsOpen: true });
    server.lingua = notInstalled({ installable: false });
    render(<App />);
    const link = await screen.findByRole('link', { name: 'Available in distill full' });
    expect(link).toHaveAttribute('href', 'https://github.com/nievesjesus/distill/releases/latest');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/npm was not found/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install (~520 MB)' })).toBeNull();
    expect(screen.getByRole('switch', { name: /LLMLingua-2/ })).toBeDisabled();
  });

  it('hides every install control once installed', async () => {
    preset({ optionsOpen: true });
    server.lingua = installed();
    render(<App />);
    await screen.findByRole('switch', { name: /LLMLingua-2/ });
    expect(screen.queryByRole('button', { name: 'Install (~520 MB)' })).toBeNull();
    expect(screen.queryByText('Available in distill full')).toBeNull();
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

  it('shows why the model download failed when the server knows', async () => {
    preset({ optionsOpen: true, lingua: { on: true, model: 'tinybert', rate: 0.6 } });
    server.lingua = { ...installed({ state: 'error', progress: 0 }), modelError: 'huggingface.co could not be reached' };
    render(<App />);
    expect(await screen.findByText('Model download failed: huggingface.co could not be reached.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
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

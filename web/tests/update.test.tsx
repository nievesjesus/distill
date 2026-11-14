import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '@core/types';
import { Header } from '../src/components/Header';
import { UpdateBanner } from '../src/components/UpdateBanner';
import { useUpdateInfo } from '../src/state/update';

const base: UpdateInfo = {
  current: '0.1.2',
  latest: '0.2.0',
  available: true,
  method: 'npx',
  enabled: true,
  disabledBy: null,
  checkedAt: '2026-11-14T00:00:00.000Z',
  canInstall: false,
  install: { state: 'idle' },
};

let current: UpdateInfo;
let calls: Array<{ url: string; method: string; body?: string }>;
let getResponses: UpdateInfo[];

function Harness() {
  const update = useUpdateInfo();
  return (
    <>
      <Header mode="compact" onModeChange={() => {}} update={update} />
      <UpdateBanner update={update} />
    </>
  );
}

async function mount(info: Partial<UpdateInfo> = {}) {
  current = { ...base, ...info };
  render(<Harness />);
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  getResponses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url === '/api/update/install') {
        current = { ...current, install: { state: 'running' } };
        return Response.json(current, { status: 202 });
      }
      if (url === '/api/update/settings') {
        current = { ...current, enabled: JSON.parse(String(init?.body)).enabled };
        return Response.json(current);
      }
      if (url === '/api/update/check') return Response.json(current);
      if (url === '/api/update') {
        const next = getResponses.shift();
        if (next) current = next;
        return Response.json(current);
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UpdateBanner', () => {
  it('shows the version notice with the npx command and a Copy button', async () => {
    await mount();
    expect(screen.getByRole('status')).toHaveTextContent('distill 0.2.0 is available. You have 0.1.2.');
    expect(screen.getByText('npx distill-llm@latest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('shows the pinned npm command for a global install without install rights', async () => {
    await mount({ method: 'npm-global' });
    expect(screen.getByText('npm install -g distill-llm@0.2.0')).toBeInTheDocument();
  });

  it('is hidden when updates are disabled, on desktop, or when nothing is available', async () => {
    await mount({ enabled: false });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is hidden for the desktop method', async () => {
    await mount({ method: 'desktop' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays dismissed for the same version after a remount', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(localStorage.getItem('distill:update-dismissed')).toBe('0.2.0');
    document.body.innerHTML = '';
    await mount();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('installs, polls while running, then reports the new version', async () => {
    vi.useFakeTimers();
    await mount({ canInstall: true });
    getResponses = [
      { ...base, canInstall: true, install: { state: 'running' } },
      { ...base, canInstall: true, install: { state: 'done', version: '0.2.0' } },
    ];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    expect(calls.some((c) => c.url === '/api/update/install' && c.method === 'POST')).toBe(true);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Updated to 0.2.0. Restart distill to use it.');
    const polls = calls.filter((c) => c.url === '/api/update').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls.filter((c) => c.url === '/api/update').length).toBe(polls);
  });

  it('shows the failure and offers Retry', async () => {
    await mount({ canInstall: true, install: { state: 'failed', error: 'EACCES: permission denied' } });
    expect(screen.getByRole('status')).toHaveTextContent('EACCES: permission denied');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('VersionMenu', () => {
  it('shows the current version and sends the daily-check setting', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'v0.1.2' }));
    const box = screen.getByRole('checkbox', { name: 'Check for updates daily' });
    expect(box).toBeChecked();
    await act(async () => {
      fireEvent.click(box);
    });
    const put = calls.find((c) => c.url === '/api/update/settings');
    expect(put?.method).toBe('PUT');
    expect(put?.body).toBe('{"enabled":false}');
  });

  it('disables the checkbox when the environment turned checks off', async () => {
    await mount({ enabled: false, disabledBy: 'env' });
    fireEvent.click(screen.getByRole('button', { name: 'v0.1.2' }));
    expect(screen.getByRole('checkbox', { name: 'Check for updates daily' })).toBeDisabled();
    expect(screen.getByText('Turned off by DISTILL_NO_UPDATE_CHECK')).toBeInTheDocument();
  });

  it('says Up to date and closes on Escape returning focus', async () => {
    await mount({ available: false, latest: '0.1.2' });
    const button = screen.getByRole('button', { name: 'v0.1.2' });
    fireEvent.click(button);
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Up to date')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('closes on outside click', async () => {
    await mount({ available: false, latest: '0.1.2' });
    fireEvent.click(screen.getByRole('button', { name: 'v0.1.2' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Up to date')).toBeNull();
  });

  it('Check now refreshes the info and clears the dismissal', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'v0.1.2' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    });
    expect(calls.some((c) => c.url === '/api/update/check' && c.method === 'POST')).toBe(true);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('without update data', () => {
  it('renders nothing when the load fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    render(<Harness />);
    await act(async () => {});
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /^v\d/ })).toBeNull();
  });
});

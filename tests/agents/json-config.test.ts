import { describe, expect, it } from 'vitest';
import { planServerInstall, planServerRemove, serverState } from '../../src/agents/json-config';

const entry = { type: 'stdio', command: 'distill-llm', args: ['mcp'] };

describe('json server config', () => {
  it('adds the server to an empty or missing file', () => {
    for (const current of [null, '', '{}']) {
      const plan = planServerInstall(current, ['mcpServers', 'distill'], entry);
      expect(plan.changed).toBe(true);
      expect(JSON.parse(plan.next)).toEqual({ mcpServers: { distill: entry } });
    }
  });

  it('keeps other servers and unrelated keys', () => {
    const current = JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'o' } } });
    const plan = planServerInstall(current, ['mcpServers', 'distill'], entry);
    expect(JSON.parse(plan.next)).toEqual({ theme: 'x', mcpServers: { other: { command: 'o' }, distill: entry } });
  });

  it('is idempotent and updates our own entry', () => {
    const first = planServerInstall(null, ['mcpServers', 'distill'], entry);
    expect(planServerInstall(first.next, ['mcpServers', 'distill'], entry).changed).toBe(false);
    const moved = planServerInstall(first.next, ['mcpServers', 'distill'], { ...entry, command: '/opt/distill-llm' });
    expect(moved.changed).toBe(true);
    expect(JSON.parse(moved.next).mcpServers.distill.command).toBe('/opt/distill-llm');
  });

  it('refuses to overwrite a distill entry that is not ours', () => {
    const current = JSON.stringify({ mcpServers: { distill: { command: 'mine' } } });
    expect(serverState(current, ['mcpServers', 'distill'])).toBe('foreign');
    expect(() => planServerInstall(current, ['mcpServers', 'distill'], entry)).toThrow(/not created by distill/);
  });

  it('reports the state', () => {
    expect(serverState(null, ['mcpServers', 'distill'])).toBe('none');
    expect(serverState('{}', ['mcpServers', 'distill'])).toBe('none');
    expect(serverState(JSON.stringify({ mcpServers: { distill: entry } }), ['mcpServers', 'distill'])).toBe('own');
  });

  it('removes only our entry and prunes empty containers', () => {
    const both = JSON.stringify({ mcpServers: { other: { command: 'o' }, distill: entry } });
    expect(JSON.parse(planServerRemove(both, ['mcpServers', 'distill']).next)).toEqual({ mcpServers: { other: { command: 'o' } } });
    const only = JSON.stringify({ a: 1, mcpServers: { distill: entry } });
    expect(JSON.parse(planServerRemove(only, ['mcpServers', 'distill']).next)).toEqual({ a: 1 });
    const foreign = JSON.stringify({ mcpServers: { distill: { command: 'mine' } } });
    expect(planServerRemove(foreign, ['mcpServers', 'distill']).changed).toBe(false);
    expect(planServerRemove('{}', ['mcpServers', 'distill']).changed).toBe(false);
  });

  it('supports a nested path', () => {
    const plan = planServerInstall(null, ['mcp', 'servers', 'distill'], { type: 'local', command: ['distill-llm', 'mcp'] });
    expect(JSON.parse(plan.next).mcp.servers.distill.type).toBe('local');
  });

  it('reports parse errors without changing anything', () => {
    expect(() => planServerInstall('{ nope', ['mcpServers', 'distill'], entry)).toThrow();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { FileRow } from '../src/components/FileRow';
import { Header } from '../src/components/Header';
import { ERROR_MESSAGES } from '../src/strings';
import type { FileEntry } from '../src/state/files';

function errored(code: keyof typeof ERROR_MESSAGES): FileEntry {
  return { localId: 'f1', name: 'a.docx', size: 1, kind: 'DOCX', status: 'error', error: { code, message: code } };
}

describe('error messages', () => {
  it('uses the actionable copy', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      unsupported_type: 'Unsupported file type',
      needs_libreoffice: 'Office files need LibreOffice — install it and restart distill',
      too_large: 'File is larger than the size limit',
      password_protected: 'Password-protected file',
      timeout: 'Took too long to parse',
      parse_failed: 'Could not read this file',
    });
  });

  it('needs_libreoffice row shows install hint link', () => {
    render(<ul><FileRow file={errored('needs_libreoffice')} /></ul>);
    const link = screen.getByRole('link', { name: 'Get LibreOffice' });
    expect(link).toHaveAttribute('href', 'https://www.libreoffice.org/download/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('.file-error')).toHaveTextContent('Office files need LibreOffice — install it and restart distill');
  });

  it('does not show the link for other errors', () => {
    render(<ul><FileRow file={errored('timeout')} /></ul>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('Connect panel', () => {
  it('lists Claude Code, Claude Desktop, OpenCode, Codex and ChatGPT with "coming in v0.2" for MCP', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect your agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect your agent' });
    for (const name of ['Claude Code', 'Claude Desktop', 'OpenCode', 'Codex', 'ChatGPT']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText('coming in v0.2').length).toBeGreaterThanOrEqual(5);
    expect(dialog).toHaveTextContent('claude mcp add distill -- npx -y distillmd mcp');
    expect(dialog).toHaveTextContent('Hooks for Claude Code and OpenCode arrive in v0.3.');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<Header mode="compact" onModeChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Connect your agent' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Connect your agent' });
    expect(dialog).toHaveAttribute('open');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).not.toHaveAttribute('open');
    expect(trigger).toHaveFocus();
  });

  it('closes with the close button and returns focus', () => {
    render(<Header mode="compact" onModeChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Connect your agent' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

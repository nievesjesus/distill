import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Header } from '../src/components/Header';

describe('Header', () => {
  it('renders the brand and the connect button and the GitHub link with accessible names', () => {
    render(<Header mode="compact" onModeChange={() => {}} />);
    expect(screen.getByText('distill')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect your agent' })).toBeInTheDocument();
    const github = screen.getByRole('link', { name: 'Source on GitHub' });
    expect(github).toHaveAttribute('href', 'https://github.com/nievesjesus/distill');
  });

  it('exposes Compact and Detailed as pressed-state buttons', () => {
    render(<Header mode="compact" onModeChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Detailed' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the chosen mode', () => {
    const modes: string[] = [];
    render(<Header mode="compact" onModeChange={(m) => modes.push(m)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }));
    expect(modes).toEqual(['detailed']);
  });
});

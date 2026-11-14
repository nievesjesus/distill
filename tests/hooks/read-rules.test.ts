import { describe, expect, it } from 'vitest';
import { type MatchContext, parseReadRule, ruleMayMatch } from '../../src/hooks/read-rules';

const ctx: MatchContext = { cwd: '/p', home: '/h', platform: 'linux' };

const m = (rule: string, path: string, root: string | null = '/p', c: MatchContext = ctx) =>
  ruleMayMatch(parseReadRule(rule, root)!, path, c);

describe('parseReadRule', () => {
  it('ignores rules that are not Read rules', () => {
    expect(parseReadRule('Bash(ls)', null)).toBeNull();
    expect(parseReadRule('WebFetch', null)).toBeNull();
  });

  it('parses bare and scoped Read rules', () => {
    expect(parseReadRule('Read', null)).toEqual({ spec: null, root: null });
    expect(parseReadRule('Read(./.env)', '/p')).toEqual({ spec: './.env', root: '/p' });
  });

  it('treats other Read-prefixed names as match-all', () => {
    expect(parseReadRule('ReadFoo', null)).toEqual({ spec: null, root: null });
  });
});

describe('ruleMayMatch', () => {
  it('matches everything for bare and wildcard rules', () => {
    expect(m('Read', '/p/b.pdf')).toBe(true);
    expect(m('Read(**)', '/p/b.pdf')).toBe(true);
    expect(m('Read(*)', '/p/b.pdf')).toBe(true);
    expect(m('Read()', '/p/b.pdf')).toBe(true);
  });

  it('matches ** followed by a slash against zero folders', () => {
    expect(m('Read(**/*.pdf)', '/p/b.pdf')).toBe(true);
    expect(m('Read(./a/**/x.pdf)', '/p/a/x.pdf')).toBe(true);
  });

  it('matches relative rules against the settings root as well as the cwd', () => {
    expect(m('Read(./sub/private/**)', '/p/sub/private/x.pdf', '/p', { ...ctx, cwd: '/p/sub' })).toBe(true);
  });

  it('matches cwd-relative patterns', () => {
    expect(m('Read(./.env)', '/p/b.pdf')).toBe(false);
    expect(m('Read(./.env)', '/p/.env')).toBe(true);
    expect(m('Read(./secrets/**)', '/p/secrets/a.pdf')).toBe(true);
    expect(m('Read(./secrets/**)', '/p/b.pdf')).toBe(false);
    expect(m('Read(./secrets)', '/p/secrets/a.pdf')).toBe(true);
    expect(m('Read(secrets/*.pdf)', '/p/secrets/a.pdf')).toBe(true);
    expect(m('Read(secrets/*.pdf)', '/p/secrets/x/a.pdf')).toBe(false);
  });

  it('matches slash-free patterns against the basename and ancestors', () => {
    expect(m('Read(*.pdf)', '/p/sub/deep/x.pdf')).toBe(true);
    expect(m('Read(*.docx)', '/p/sub/x.pdf')).toBe(false);
    expect(m('Read(private)', '/p/a/private/x.pdf')).toBe(true);
  });

  it('resolves absolute, home and root-relative prefixes', () => {
    expect(m('Read(//etc/**)', '/etc/x.pdf')).toBe(true);
    expect(m('Read(//etc/**)', '/p/x.pdf')).toBe(false);
    expect(m('Read(~/Documents/**)', '/h/Documents/a.pdf')).toBe(true);
    expect(m('Read(~/Documents/**)', '/p/a.pdf')).toBe(false);
    expect(m('Read(/docs/**)', '/p/docs/a.pdf', '/p')).toBe(true);
    expect(m('Read(/docs/**)', '/p/b.pdf', '/p')).toBe(false);
    expect(m('Read(/docs/**)', '/p/b.pdf', null)).toBe(true);
  });

  it('is conservative for syntax it does not translate', () => {
    expect(m('Read(./[ab].pdf)', '/p/c.pdf')).toBe(true);
    expect(m('Read(./{a,b}.pdf)', '/p/c.pdf')).toBe(true);
    expect(m('Read(!./a.pdf)', '/p/c.pdf')).toBe(true);
    expect(m('Read(./a\\ b.pdf)', '/p/c.pdf')).toBe(true);
  });

  it('is conservative for relative segments, bare ~, $ and padded specs', () => {
    expect(m('Read(../secrets/**)', '/p/b.pdf')).toBe(true);
    expect(m('Read(//p/./x/**)', '/q/b.pdf')).toBe(true);
    expect(m('Read(~)', '/p/b.pdf')).toBe(true);
    expect(m('Read($HOME/x/**)', '/p/b.pdf')).toBe(true);
    expect(m('Read( ./secrets/** )', '/p/b.pdf')).toBe(true);
  });

  it('translates ? and escapes regex metacharacters', () => {
    expect(m('Read(./a?.pdf)', '/p/ab.pdf')).toBe(true);
    expect(m('Read(./a?.pdf)', '/p/a/.pdf')).toBe(false);
    expect(m('Read(./a+b.pdf)', '/p/aab.pdf')).toBe(false);
  });

  it('compares case-insensitively on darwin and win32 only', () => {
    expect(m('Read(./Secrets/**)', '/p/secrets/a.pdf', '/p', { ...ctx, platform: 'darwin' })).toBe(true);
    expect(m('Read(./Secrets/**)', '/p/secrets/a.pdf', '/p', ctx)).toBe(false);
  });

  it('normalizes windows paths', () => {
    const win: MatchContext = { cwd: 'C:\\p', home: 'C:\\h', platform: 'win32' };
    expect(m('Read(./secrets/**)', 'C:\\p\\secrets\\a.pdf', 'C:\\p', win)).toBe(true);
    expect(m('Read(//c/x/**)', 'C:\\x\\a.pdf', 'C:\\p', win)).toBe(true);
    expect(m('Read(./secrets/**)', 'C:\\p\\b.pdf', 'C:\\p', win)).toBe(false);
  });
});

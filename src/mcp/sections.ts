import { buildOutline, headingsOf } from '../core/outline';

const MAX_SUGGESTIONS = 5;

export function normalizeTitle(text: string): string {
  return text
    .replace(/^[#\s]+/, '')
    .replace(/[#\s]+$/, '')
    .replace(/!?\[([^\]]*)\]\((?:[^()"]|\([^()]*\)|"[^"]*")*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_]+(?=\S)/g, '$1')
    .replace(/(?<=\S)[*_]+(?=$|[\s).,;:!?])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looseTitle(text: string): string {
  return normalizeTitle(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

interface Candidate {
  title: string;
  norm: string;
  loose: string;
  line: number;
  endLine: number;
}

function candidates(markdown: string): Candidate[] {
  const total = markdown.split('\n').length;
  const headings = headingsOf(markdown);
  if (headings.length > 0) {
    return headings.map((heading, index) => {
      const next = headings.slice(index + 1).find((other) => other.level <= heading.level);
      return {
        title: heading.title,
        norm: normalizeTitle(heading.title),
        loose: looseTitle(heading.title),
        line: heading.line,
        endLine: next ? next.line - 1 : total,
      };
    });
  }
  return buildOutline(markdown).entries.map((entry) => ({
    title: entry.title,
    norm: normalizeTitle(entry.title),
    loose: looseTitle(entry.title),
    line: entry.line,
    endLine: entry.endLine,
  }));
}

type Test = (have: string, want: string) => boolean;

const STAGES: Test[] = [(have, want) => have === want, (have, want) => have.startsWith(want), (have, want) => have.includes(want)];

export function findSection(markdown: string, section: string): { line: number; endLine: number } | null {
  const wantedNorm = normalizeTitle(section);
  const wantedLoose = looseTitle(section);
  if (wantedNorm === '' && wantedLoose === '') return null;
  const list = candidates(markdown);
  for (const test of STAGES) {
    const hit = list.find((item) => (wantedNorm !== '' && test(item.norm, wantedNorm)) || (wantedLoose !== '' && test(item.loose, wantedLoose)));
    if (hit) return { line: hit.line, endLine: hit.endLine };
  }
  return null;
}

function tokens(text: string): Set<string> {
  return new Set(looseTitle(text).split(' ').filter((part) => part !== ''));
}

export function closestHeadings(markdown: string, section: string): string[] {
  const wanted = tokens(section);
  const list = candidates(markdown).map((item) => ({ title: item.norm === '' ? item.title : cleanTitle(item.title), tokens: tokens(item.title) }));
  const scored = list
    .map((item, index) => {
      let shared = 0;
      for (const token of wanted) if (item.tokens.has(token)) shared += 1;
      const union = new Set([...wanted, ...item.tokens]).size;
      return { title: item.title, index, score: union === 0 ? 0 : shared / union };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS);
  if (scored.length > 0) return scored.map((item) => item.title);
  return list.slice(0, MAX_SUGGESTIONS).map((item) => item.title);
}

function cleanTitle(text: string): string {
  return text
    .replace(/^[#\s]+/, '')
    .replace(/[#\s]+$/, '')
    .replace(/!?\[([^\]]*)\]\((?:[^()"]|\([^()]*\)|"[^"]*")*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[`*]|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

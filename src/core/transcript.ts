export type TimestampMode = 'none' | 'coarse' | 'segment';
export type TranscriptLang = 'en' | 'es';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Slide {
  at: number;
  lines: string[];
}

export interface FormatOptions {
  timestamps?: TimestampMode;
  lang?: TranscriptLang;
  slides?: readonly Slide[];
}

export const TRANSCRIPT_ENGINE = 'local ASR (Parakeet TDT 0.6B v3)';

const PARAGRAPH_GAP_SECONDS = 2;
const PARAGRAPH_WORDS = 120;
const COARSE_STAMP_SECONDS = 60;

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function srtClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const whole = Math.floor(total / 1000);
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)},${pad(ms, 3)}`;
}

export function renderSrt(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment, index) => `${index + 1}\n${srtClock(segment.start)} --> ${srtClock(segment.end)}\n${segment.text}\n`).join('\n');
}

const WORD_EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}'’-])`;
const WORD_EDGE_AFTER = String.raw`(?![\p{L}\p{N}'’-])`;

const FILLER_WORDS: Record<TranscriptLang, string> = { en: 'um+|uh+|erm|ah', es: 'eh|em' };
const FILLER_PHRASES: Record<TranscriptLang, string> = { en: 'you know|I mean', es: 'este|o sea' };

const REPEAT_KEEP: ReadonlySet<string> = new Set(['had', 'that', 'is']);

function fixSpacing(text: string): string {
  return text
    .replace(/([,;])(?=[\p{L}$€£¥¿¡(])/gu, '$1 ')
    .replace(/(?<=\D)([,;])(?=\d)/gu, '$1 ')
    .replace(/([!?])(?=[\p{L}\p{N}$€£¥¿¡(])/gu, '$1 ')
    .replace(/(:)(?=[$€£¥¿¡(])/gu, '$1 ')
    .replace(/(?<=\p{Ll})\.(?=\p{Lu}\p{Ll})/gu, '. ');
}

function dropFillers(text: string, lang: TranscriptLang): string {
  const phrases = new RegExp(`,\\s*(?:${FILLER_PHRASES[lang]})\\s*,`, 'giu');
  const opening = new RegExp(`(^|[.!?]\\s+)(${FILLER_WORDS[lang]})${WORD_EDGE_AFTER}[,.]?\\s*(\\p{L})?`, 'giu');
  const inside = new RegExp(`(,?)\\s+(?:${FILLER_WORDS[lang]})${WORD_EDGE_AFTER}(,?)`, 'giu');
  return text
    .replace(phrases, ',')
    .replace(opening, (_all, lead: string, word: string, next: string | undefined) => {
      if (next === undefined) return lead;
      return lead + (/^\p{Lu}/u.test(word) ? next.toUpperCase() : next);
    })
    .replace(inside, (all: string, before: string, after: string, offset: number, whole: string) => {
      const following = whole.charAt(offset + all.length);
      if (/[.!?;:]/.test(following)) return '';
      return before !== '' || after !== '' ? ',' : '';
    });
}

function collapseRepeats(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}])(\p{L}+)((?:\s+\1)+)(?![\p{L}\p{N}])/giu, (all, word: string) => (REPEAT_KEEP.has(word.toLowerCase()) ? all : word));
}

function clean(text: string, lang: TranscriptLang | undefined): string {
  const spaced = fixSpacing(text);
  const stripped = lang === undefined ? spaced : dropFillers(spaced, lang);
  return collapseRepeats(stripped).replace(/[ \t]{2,}/g, ' ').trim();
}

interface Paragraph {
  start: number;
  text: string;
  words: number;
  epoch: number;
}

type Block = { kind: 'speech'; start: number; text: string } | { kind: 'slide'; at: number; text: string };

const wordCount = (text: string) => (text === '' ? 0 : text.split(/\s+/).length);

function slideText(slide: Slide): string {
  return [`> [slide ${formatClock(slide.at)}]`, ...slide.lines.map((line) => `> ${line}`)].join('\n');
}

export function formatTranscript(segments: readonly TranscriptSegment[], options: FormatOptions = {}): string {
  const mode = options.timestamps ?? 'coarse';
  const slides = [...(options.slides ?? [])].sort((a, b) => a.at - b.at);
  const epochOf = (start: number) => slides.filter((slide) => slide.at <= start).length;

  const cleaned = segments
    .map((segment) => ({ start: segment.start, end: segment.end, text: clean(segment.text, options.lang) }))
    .filter((segment) => segment.text !== '');

  const paragraphs: Paragraph[] = [];
  if (mode === 'segment') {
    for (const segment of cleaned) paragraphs.push({ start: segment.start, text: segment.text, words: wordCount(segment.text), epoch: 0 });
  } else {
    let previousEnd = 0;
    for (const segment of cleaned) {
      const current = paragraphs[paragraphs.length - 1];
      const epoch = epochOf(segment.start);
      const split = current === undefined || segment.start - previousEnd > PARAGRAPH_GAP_SECONDS || current.words >= PARAGRAPH_WORDS || current.epoch !== epoch;
      if (split) {
        paragraphs.push({ start: segment.start, text: segment.text, words: wordCount(segment.text), epoch });
      } else {
        current.text = `${current.text} ${segment.text}`;
        current.words += wordCount(segment.text);
      }
      previousEnd = segment.end;
    }
  }

  const blocks: Block[] = [];
  let nextSlide = 0;
  let lastStamp = Number.NEGATIVE_INFINITY;
  for (const paragraph of paragraphs) {
    while (nextSlide < slides.length && slides[nextSlide].at <= paragraph.start) {
      blocks.push({ kind: 'slide', at: slides[nextSlide].at, text: slideText(slides[nextSlide]) });
      nextSlide++;
    }
    let stamp = '';
    if (mode === 'segment' || (mode === 'coarse' && paragraph.start - lastStamp >= COARSE_STAMP_SECONDS)) {
      stamp = `[${formatClock(paragraph.start)}] `;
      lastStamp = paragraph.start;
    }
    blocks.push({ kind: 'speech', start: paragraph.start, text: `${stamp}${paragraph.text}` });
  }
  for (; nextSlide < slides.length; nextSlide++) blocks.push({ kind: 'slide', at: slides[nextSlide].at, text: slideText(slides[nextSlide]) });

  let out = '';
  blocks.forEach((block, index) => {
    if (index > 0) out += mode === 'segment' && block.kind === 'speech' && blocks[index - 1].kind === 'speech' ? '\n' : '\n\n';
    out += block.text;
  });
  return out;
}

const STOPWORDS: Record<TranscriptLang, ReadonlySet<string>> = {
  en: new Set('the and is are was were to of in that it for with this we you they have has not but on be will can so at as from what there them'.split(' ')),
  es: new Set('el la los las de que y en es un una por con para se lo del al como pero más mas su sus está este esto son fue ellos hay muy ya nos le les vamos entonces bueno'.split(' ')),
};

const MIN_LANG_HITS = 3;
const LANG_DOMINANCE = 2;

export function detectLang(segments: readonly TranscriptSegment[]): TranscriptLang | undefined {
  const counts: Record<TranscriptLang, number> = { en: 0, es: 0 };
  for (const segment of segments) {
    for (const word of segment.text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      if (STOPWORDS.en.has(word)) counts.en++;
      if (STOPWORDS.es.has(word)) counts.es++;
    }
  }
  const [winner, loser]: TranscriptLang[] = counts.en >= counts.es ? ['en', 'es'] : ['es', 'en'];
  if (counts[winner] < MIN_LANG_HITS || counts[winner] < counts[loser] * LANG_DOMINANCE) return undefined;
  return winner;
}

export function transcriptHeader(info: { name: string; duration: number; lang?: TranscriptLang }): string {
  const parts = [`transcript of ${info.name}`, formatClock(info.duration), ...(info.lang ? [info.lang] : []), TRANSCRIPT_ENGINE];
  return `<!-- distill: ${parts.join(', ')} -->`;
}

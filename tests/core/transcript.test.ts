import { describe, expect, it } from 'vitest';
import { detectLang, formatClock, formatTranscript, renderSrt, transcriptHeader } from '../../src/core/transcript';

const seg = (start: number, end: number, text: string) => ({ start, end, text });
const one = (text: string, lang?: 'en' | 'es') => formatTranscript([seg(0, 5, text)], { timestamps: 'none', ...(lang ? { lang } : {}) });

describe('formatClock', () => {
  it('uses mm:ss under an hour and h:mm:ss from an hour', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65.9)).toBe('01:05');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('paragraphs', () => {
  it('splits on a gap over 2 s but not on exactly 2 s', () => {
    const text = formatTranscript([seg(0, 4, 'First.'), seg(6, 8, 'Same paragraph.'), seg(10.5, 12, 'New paragraph.')], { timestamps: 'none' });
    expect(text).toBe('First. Same paragraph.\n\nNew paragraph.');
  });

  it('starts a new paragraph after about 120 words', () => {
    const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
    const text = formatTranscript([seg(0, 30, long), seg(30, 32, 'next one')], { timestamps: 'none' });
    expect(text).toBe(`${long}\n\nnext one`);
  });

  it('keeps short runs together', () => {
    const text = formatTranscript([seg(0, 1, 'a b'), seg(1, 2, 'c d')], { timestamps: 'none' });
    expect(text).toBe('a b c d');
  });

  it('returns an empty string for no segments', () => {
    expect(formatTranscript([], { timestamps: 'coarse' })).toBe('');
  });
});

describe('timestamps', () => {
  const spaced = [seg(0, 2, 'one'), seg(10, 12, 'two'), seg(40, 42, 'three'), seg(70, 72, 'four'), seg(100, 102, 'five'), seg(130, 132, 'six')];

  it('coarse stamps a paragraph at most once every 60 s', () => {
    expect(formatTranscript(spaced, { timestamps: 'coarse' })).toBe('[00:00] one\n\ntwo\n\nthree\n\n[01:10] four\n\nfive\n\n[02:10] six');
  });

  it('is coarse by default', () => {
    expect(formatTranscript(spaced, {})).toBe(formatTranscript(spaced, { timestamps: 'coarse' }));
  });

  it('none writes no stamps', () => {
    expect(formatTranscript(spaced, { timestamps: 'none' })).not.toContain('[');
  });

  it('segment stamps every segment on its own line', () => {
    expect(formatTranscript([seg(0, 2, 'one'), seg(2.5, 4, 'two'), seg(3700, 3702, 'late')], { timestamps: 'segment' })).toBe('[00:00] one\n[00:02] two\n[1:01:40] late');
  });

  it('uses h:mm:ss after an hour', () => {
    expect(formatTranscript([seg(3725, 3730, 'late')], { timestamps: 'coarse' })).toBe('[1:02:05] late');
  });
});

describe('fillers in English', () => {
  it('drops um, uh, erm and ah between words', () => {
    expect(one('So, um, we went there', 'en')).toBe('So, we went there');
    expect(one('it was uh really good', 'en')).toBe('it was really good');
    expect(one('we erm left early', 'en')).toBe('we left early');
    expect(one('The total was, ah, big', 'en')).toBe('The total was, big');
  });

  it('drops a filler that opens a sentence and recapitalises', () => {
    expect(one('Um, so we left. Uh, then we ate.', 'en')).toBe('So we left. Then we ate.');
  });

  it('drops a filler at the end of a sentence', () => {
    expect(one('We left, um.', 'en')).toBe('We left.');
  });

  it('never leaves orphan punctuation behind', () => {
    expect(one('Ah! Great news.', 'en')).toBe('Ah! Great news.');
    expect(one('Yes. Ah! Great.', 'en')).toBe('Yes. Ah! Great.');
    expect(one('Oh, ah well; ah.', 'en')).toBe('Oh, well; ah.');
    expect(one('What? Ah?', 'en')).toBe('What? Ah?');
    expect(one('Fine; um. Then', 'en')).toBe('Fine; um. Then');
  });

  it('keeps you know and I mean unless they sit between commas', () => {
    expect(one('It was, you know, fine', 'en')).toBe('It was, fine');
    expect(one('It was, I mean, fine', 'en')).toBe('It was, fine');
    expect(one('Do you know the way', 'en')).toBe('Do you know the way');
    expect(one('I mean it', 'en')).toBe('I mean it');
    expect(one('You know what I mean', 'en')).toBe('You know what I mean');
  });

  it('never touches words that merely contain a filler', () => {
    expect(one('The umbrella and the album ahead', 'en')).toBe('The umbrella and the album ahead');
    expect(one('Uh-huh, sure', 'en')).toBe('Uh-huh, sure');
  });

  it('removes nothing without a known language', () => {
    expect(one('So, um, we went')).toBe('So, um, we went');
  });
});

describe('fillers in Spanish', () => {
  it('drops eh and em', () => {
    expect(one('Eh, entonces vamos', 'es')).toBe('Entonces vamos');
    expect(one('pues, eh, vamos', 'es')).toBe('pues, vamos');
    expect(one('fue em muy bueno', 'es')).toBe('fue muy bueno');
  });

  it('drops este only between commas and o sea only when standalone', () => {
    expect(one('Fue, este, muy largo', 'es')).toBe('Fue, muy largo');
    expect(one('Este libro es bueno', 'es')).toBe('Este libro es bueno');
    expect(one('Dame este', 'es')).toBe('Dame este');
    expect(one('Fue, o sea, muy largo', 'es')).toBe('Fue, muy largo');
    expect(one('Lo hice o sea lo intenté', 'es')).toBe('Lo hice o sea lo intenté');
  });

  it('keeps the question tag ¿no?', () => {
    expect(one('Está bien, ¿no? Claro', 'es')).toBe('Está bien, ¿no? Claro');
  });

  it('does not apply English fillers to Spanish', () => {
    expect(one('um ah uh', 'es')).toBe('um ah uh');
  });
});

describe('repeated words', () => {
  it('collapses immediate repeats', () => {
    expect(one('the the cat sat sat down', 'en')).toBe('the cat sat down');
    expect(one('The the cat', 'en')).toBe('The cat');
    expect(one('de de la casa', 'es')).toBe('de la casa');
  });

  it('keeps legitimate doubles and repeats across punctuation', () => {
    expect(one('He had had enough', 'en')).toBe('He had had enough');
    expect(one('I think that that works', 'en')).toBe('I think that that works');
    expect(one('no, no way', 'en')).toBe('no, no way');
  });

  it('keeps repeated numbers', () => {
    expect(one('10 10 people', 'en')).toBe('10 10 people');
  });

  it('collapses even without a known language', () => {
    expect(one('the the end')).toBe('the end');
  });
});

describe('glued punctuation', () => {
  it('restores the space after punctuation glued to a word or symbol', () => {
    expect(one('was, ah,$4.2 million', 'en')).toBe('was, $4.2 million');
    expect(one('Hello,world and what?Yes', 'en')).toBe('Hello, world and what? Yes');
    expect(one('This ends.Next starts', 'en')).toBe('This ends. Next starts');
    expect(one('Wait,5 million', 'en')).toBe('Wait, 5 million');
  });

  it('never splits numbers', () => {
    expect(one('about 3,200 and 3.200.000 or 4.2 at 10:30', 'en')).toBe('about 3,200 and 3.200.000 or 4.2 at 10:30');
    expect(one('de 1,5 millones', 'es')).toBe('de 1,5 millones');
  });

  it('leaves abbreviations, domains and acronyms alone', () => {
    expect(one('see e.g. node.js, example.com and Node.JS', 'en')).toBe('see e.g. node.js, example.com and Node.JS');
  });
});

describe('slides', () => {
  const speech = [seg(0, 4, 'Welcome everyone.'), seg(11, 14, 'Now the second topic.'), seg(21, 25, 'Finally the third one.')];

  it('puts each slide before the speech that follows it and splits the paragraph there', () => {
    const text = formatTranscript(speech, {
      timestamps: 'none',
      slides: [
        { at: 10, lines: ['Hiring plan', '14 engineers'] },
        { at: 20, lines: ['Launch roadmap'] },
      ],
    });
    expect(text).toBe('Welcome everyone.\n\n> [slide 00:10]\n> Hiring plan\n> 14 engineers\n\nNow the second topic.\n\n> [slide 00:20]\n> Launch roadmap\n\nFinally the third one.');
  });

  it('puts a slide that opens the video before the first words', () => {
    const text = formatTranscript(speech, { timestamps: 'none', slides: [{ at: 0, lines: ['Title'] }] });
    expect(text.startsWith('> [slide 00:00]\n> Title\n\nWelcome everyone.')).toBe(true);
  });

  it('appends slides that come after the last words', () => {
    const text = formatTranscript(speech, { timestamps: 'none', slides: [{ at: 90, lines: ['Thanks'] }] });
    expect(text.endsWith('Finally the third one.\n\n> [slide 01:30]\n> Thanks')).toBe(true);
  });

  it('works with no speech at all', () => {
    expect(formatTranscript([], { slides: [{ at: 5, lines: ['Only slide'] }] })).toBe('> [slide 00:05]\n> Only slide');
  });
});

describe('renderSrt', () => {
  it('numbers the cues and uses comma milliseconds', () => {
    expect(renderSrt([seg(0, 2.5, 'Hello there'), seg(3725.04, 3727, 'Later')])).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello there\n\n2\n01:02:05,040 --> 01:02:07,000\nLater\n');
  });
});

describe('detectLang', () => {
  it('recognises English and Spanish from common words', () => {
    expect(detectLang([seg(0, 5, 'This is the plan for the quarter and we will go to the office with them')])).toBe('en');
    expect(detectLang([seg(0, 5, 'Este es el plan para el trimestre y vamos a ir a la oficina con ellos')])).toBe('es');
  });

  it('returns undefined when it cannot tell', () => {
    expect(detectLang([seg(0, 5, 'Parakeet 42')])).toBeUndefined();
    expect(detectLang([])).toBeUndefined();
  });
});

describe('transcriptHeader', () => {
  it('cannot be closed early by a file name', () => {
    const header = transcriptHeader({ name: 'a --> <b>--!>x.mp3', duration: 5 });
    expect(header.slice(4, -4)).not.toContain('--');
    expect(header.endsWith(' -->')).toBe(true);
    expect(header).toContain('a');
  });

  it('names the file, duration, language and engine', () => {
    expect(transcriptHeader({ name: 'call.m4a', duration: 1623.4, lang: 'es' })).toBe('<!-- distill: transcript of call.m4a, 27:03, es, local ASR (Parakeet TDT 0.6B v3) -->');
  });

  it('omits the language when unknown', () => {
    expect(transcriptHeader({ name: 'a.mp3', duration: 3725 })).toBe('<!-- distill: transcript of a.mp3, 1:02:05, local ASR (Parakeet TDT 0.6B v3) -->');
  });
});

describe('transcriptHeader engines', () => {
  it('names the engine and accepts any detected language', () => {
    expect(transcriptHeader({ name: 'a.mp3', duration: 5, lang: 'ja', engine: 'local ASR (Whisper small)' })).toBe('<!-- distill: transcript of a.mp3, 00:05, ja, local ASR (Whisper small) -->');
    expect(transcriptHeader({ name: 'a.mp3', engine: 'local ASR (Whisper large-v3-turbo)' })).toBe('<!-- distill: transcript of a.mp3, local ASR (Whisper large-v3-turbo) -->');
  });
});

describe('CJK text', () => {
  const zh = '你好,世界。我们今天开始!好吗?可以';
  const ja = '今日は晴れです;明日も晴れでしょう?はい!分かりました,ありがとう';

  it('does not insert spaces between CJK characters', () => {
    expect(one(zh)).toBe(zh);
    expect(one(ja)).toBe(ja);
    expect(one('こんにちは,世界')).toBe('こんにちは,世界');
  });

  it('does not collapse repeated CJK words', () => {
    expect(one('对 对 对,我们走')).toBe('对 对 对,我们走');
    expect(one('はい はい はい')).toBe('はい はい はい');
    expect(one('the the plan')).toBe('the plan');
  });

  it('joins neighbouring CJK segments without a space but keeps spaces for Latin text', () => {
    expect(formatTranscript([seg(0, 2, '你好世界。'), seg(2.5, 4, '我们开始。')], { timestamps: 'none' })).toBe('你好世界。我们开始。');
    expect(formatTranscript([seg(0, 2, 'こんにちは'), seg(2.5, 4, '世界')], { timestamps: 'none' })).toBe('こんにちは世界');
    expect(formatTranscript([seg(0, 2, 'Hello there.'), seg(2.5, 4, 'Second one.')], { timestamps: 'none' })).toBe('Hello there. Second one.');
    expect(formatTranscript([seg(0, 2, '你好'), seg(2.5, 4, 'world')], { timestamps: 'none' })).toBe('你好 world');
  });

  it('starts a new paragraph on long CJK runs and on pauses, keeping timestamps', () => {
    const long = '我'.repeat(260);
    const text = formatTranscript([seg(0, 5, long), seg(5.5, 8, '你好。')], { timestamps: 'none' });
    expect(text).toBe(`${long}\n\n你好。`);
    expect(formatTranscript([seg(0, 2, '你好。'), seg(70, 72, '再见。')], { timestamps: 'coarse' })).toBe('[00:00] 你好。\n\n[01:10] 再见。');
  });

  it('keeps the spaces of Korean text', () => {
    expect(formatTranscript([seg(0, 2, '안녕하세요 여러분입니다'), seg(2.5, 4, '저는 오늘 왔습니다')], { timestamps: 'none' })).toBe('안녕하세요 여러분입니다 저는 오늘 왔습니다');
    expect(one('좋아요,그래요')).toBe('좋아요, 그래요');
    expect(one('네 네 네')).toBe('네');
    expect(formatTranscript([seg(0, 2, '합니다'), seg(2.5, 4, '저는')], { timestamps: 'none' })).toBe('합니다 저는');
  });

  it('leaves fillers alone when no language is given', () => {
    expect(one('um 你好 uh 世界')).toBe('um 你好 uh 世界');
  });
});

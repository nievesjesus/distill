import { describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { readFeed } from '../../../src/node/web/feed';

const deps = { now: () => new Date('2026-01-02T03:04:05Z'), label: 'feed.xml' };
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text));

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>Example &amp; Sons Blog</title>
<link>https://blog.example.com/</link>
<description>Notes on building things</description>
<item>
<title>First post</title>
<link>https://blog.example.com/first</link>
<pubDate>Wed, 19 Nov 2025 09:30:00 GMT</pubDate>
<description><![CDATA[<p>The <b>first</b> post is about <a href="https://x.example/a">widgets</a>.</p>]]></description>
</item>
<item>
<title>Second &lt;post&gt;</title>
<link>https://blog.example.com/second</link>
<dc:date>2025-11-20T10:00:00Z</dc:date>
<description>Plain summary &amp; more.</description>
</item>
<item>
<title></title>
<guid>https://blog.example.com/no-title</guid>
</item>
</channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Example</title>
<subtitle>An atom feed</subtitle>
<link href="https://atom.example.com/" rel="self"/>
<entry>
<title type="html">Atom entry one</title>
<link rel="alternate" href="https://atom.example.com/one"/>
<link rel="edit" href="https://atom.example.com/edit/one"/>
<updated>2025-12-01T08:00:00Z</updated>
<summary>Summary of entry one.</summary>
</entry>
<entry>
<title>Atom entry two</title>
<link href="https://atom.example.com/two"/>
<published>2025-12-02T08:00:00Z</published>
<content type="html">&lt;p&gt;Content &lt;i&gt;two&lt;/i&gt;&lt;/p&gt;</content>
</entry>
</feed>`;

const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>RDF Feed</title><description>old style</description></channel>
<item><title>RDF item</title><link>https://rdf.example.com/1</link><dc:date>2024-01-05</dc:date><description>Old summary</description></item>
</rdf:RDF>`;

describe('readFeed', () => {
  it('lists RSS entries with title, date, link and summary', () => {
    const { markdown, pages } = readFeed(bytes(rss), deps);
    expect(markdown.split('\n')[0]).toBe('<!-- distill: feed.xml converted 2026-01-02T03:04:05.000Z; untrusted feed content -->');
    expect(markdown).toContain('# Example & Sons Blog');
    expect(markdown).toContain('Notes on building things');
    expect(markdown).toContain('## First post\n\n- Date: 2025-11-19\n- Link: https://blog.example.com/first');
    expect(markdown).toContain('The **first** post is about [widgets](https://x.example/a).');
    expect(markdown).toContain('## Second <post>');
    expect(markdown).toContain('- Date: 2025-11-20');
    expect(markdown).toContain('Plain summary & more.');
    expect(pages).toBe(1);
  });

  it('falls back to the link when an item has no title', () => {
    const { markdown } = readFeed(bytes(rss), deps);
    expect(markdown).toContain('## https://blog.example.com/no-title');
  });

  it('reads Atom with the alternate link and content', () => {
    const { markdown } = readFeed(bytes(atom), deps);
    expect(markdown).toContain('# Atom Example');
    expect(markdown).toContain('An atom feed');
    expect(markdown).toContain('## Atom entry one\n\n- Date: 2025-12-01\n- Link: https://atom.example.com/one');
    expect(markdown).not.toContain('edit/one');
    expect(markdown).toContain('Summary of entry one.');
    expect(markdown).toContain('## Atom entry two');
    expect(markdown).toContain('- Link: https://atom.example.com/two');
    expect(markdown).toContain('Content *two*');
  });

  it('reads RSS 1.0 (RDF)', () => {
    const { markdown } = readFeed(bytes(rdf), deps);
    expect(markdown).toContain('# RDF Feed');
    expect(markdown).toContain('## RDF item');
    expect(markdown).toContain('- Link: https://rdf.example.com/1');
    expect(markdown).toContain('Old summary');
  });

  it('truncates long summaries and caps the entry count', () => {
    const items = Array.from({ length: 520 }, (_, i) => `<item><title>Item ${i}</title><description>${'x'.repeat(900)}</description></item>`).join('');
    const { markdown } = readFeed(bytes(`<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`), deps);
    expect(markdown).toContain('## Item 499');
    expect(markdown).not.toContain('## Item 500');
    expect(markdown).toContain('(20 more entries not shown)');
    expect(markdown).toContain('…');
  });

  it('rejects XML that is not a feed', () => {
    const error = (() => {
      try {
        readFeed(bytes('<config><a>1</a></config>'), deps);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(DistillError);
    expect((error as DistillError).code).toBe('parse_failed');
    expect((error as DistillError).message).toContain('not an RSS or Atom feed');
  });

  it('does not expand entities beyond its limits', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><rss version="2.0"><channel><title>&b;&b;&b;</title><item><title>t</title></item></channel></rss>`;
    try {
      expect(readFeed(bytes(bomb), deps).markdown.length).toBeLessThan(5000);
    } catch (error) {
      expect(error).toBeInstanceOf(DistillError);
    }
  });
});

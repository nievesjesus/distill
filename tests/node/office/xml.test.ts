import { describe, expect, it } from 'vitest';
import { attr, children, parseXml, textOf } from '../../../src/node/office/xml';

describe('parseXml', () => {
  it('walks children, attributes and text in order', () => {
    const tree = parseXml('<r xmlns:w="urn:w"><w:p w:val="1"><w:t>Hello </w:t><w:b><w:t>big</w:t></w:b><w:t> world</w:t></w:p><w:p/></r>');
    const ps = children(tree[0], 'r');
    expect(ps).toHaveLength(2);
    expect(attr(ps[0], 'val')).toBe('1');
    expect(textOf(ps[0])).toBe('Hello big world');
    expect(attr(ps[1], 'val')).toBeUndefined();
    expect(children(ps[0], 'p')).toHaveLength(3);
  });

  it('does not expand a billion-laughs document', () => {
    const a = 'a'.repeat(1000);
    const doc = `<!DOCTYPE x [<!ENTITY a "${a}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY e "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]><x>&e;</x>`;
    const out = textOf(parseXml(doc));
    expect(out.length).toBeLessThan(100);
  });

  it('does not resolve external entities', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>')).toThrowError(
      expect.objectContaining({ name: 'DistillError', code: 'parse_failed', message: 'Could not read the document XML' }),
    );
  });
});

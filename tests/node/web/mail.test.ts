import { describe, expect, it } from 'vitest';
import { DistillError } from '../../../src/node/errors';
import { readEml, readMsg } from '../../../src/node/web/mail';

const NOW = () => new Date('2026-01-02T03:04:05Z');
const deps = { now: NOW, label: 'note.eml' };
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text));

const plain = [
  'From: "Ada Lovelace" <ada@example.com>',
  'To: Bob <bob@example.com>, carol@example.com',
  'Cc: Dave <dave@example.com>',
  'Date: Thu, 19 Nov 2026 10:00:00 +0000',
  'Subject: =?UTF-8?B?UHJlc3VwdWVzdG8gMjAyNyDigJMgcmV2aXNpw7Nu?=',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hola Bob,=0D=0A=0D=0Aadjunto el presupuesto con las cifras del trimestre.=0D=0A=0D=0AGracias,=0D=0AAda',
  '',
].join('\r\n');

const withAttachment = [
  'From: ada@example.com',
  'To: bob@example.com',
  'Date: Thu, 19 Nov 2026 10:00:00 +0000',
  'Subject: Report attached',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="XX"',
  '',
  '--XX',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See the attached report.',
  '--XX',
  'Content-Type: application/pdf; name="q3-report.pdf"',
  'Content-Disposition: attachment; filename="q3-report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.alloc(3000, 7).toString('base64').replace(/(.{76})/g, '$1\r\n'),
  '--XX--',
  '',
].join('\r\n');

const htmlOnly = [
  'From: news@example.com',
  'To: bob@example.com',
  'Subject: Weekly digest',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h2>This week</h2><p>Three <b>big</b> things happened.</p><ul><li>One</li><li>Two</li></ul><p style="display:none">HIDDEN-MAIL-MARKER</p><table><tr><th>Day</th><th>Count</th></tr><tr><td>Mon</td><td>5</td></tr></table></body></html>',
  '',
].join('\r\n');

describe('readEml', () => {
  it('writes a compact header block and the text body', async () => {
    const { markdown } = await readEml(bytes(plain), deps);
    const lines = markdown.split('\n');
    expect(lines[0]).toBe('<!-- distill: note.eml converted 2026-01-02T03:04:05.000Z; untrusted email content -->');
    expect(markdown).toContain('# Presupuesto 2027 – revisión');
    expect(markdown).toContain('- From: Ada Lovelace <ada@example.com>');
    expect(markdown).toContain('- To: Bob <bob@example.com>, carol@example.com');
    expect(markdown).toContain('- Cc: Dave <dave@example.com>');
    expect(markdown).toContain('- Date: 2026-11-19T10:00:00.000Z');
    expect(markdown).toContain('Hola Bob,');
    expect(markdown).toContain('adjunto el presupuesto con las cifras del trimestre.');
    expect(markdown).not.toContain('## Attachments');
  });

  it('lists attachments with names, types and sizes without converting them', async () => {
    const { markdown } = await readEml(bytes(withAttachment), deps);
    expect(markdown).toContain('See the attached report.');
    expect(markdown).toContain('## Attachments');
    expect(markdown).toContain('- q3-report.pdf (application/pdf, 3 KB)');
  });

  it('converts an html-only body and drops hidden text', async () => {
    const { markdown } = await readEml(bytes(htmlOnly), deps);
    expect(markdown).toContain('## This week');
    expect(markdown).toContain('Three **big** things happened.');
    expect(markdown).toContain('| Day | Count |');
    expect(markdown).not.toContain('HIDDEN-MAIL-MARKER');
  });

  it('prefers the text part when both exist', async () => {
    const both = [
      'From: a@example.com',
      'Subject: Both',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Plain version',
      '--B',
      'Content-Type: text/html',
      '',
      '<p>HTML version</p>',
      '--B--',
      '',
    ].join('\r\n');
    const { markdown } = await readEml(bytes(both), deps);
    expect(markdown).toContain('Plain version');
    expect(markdown).not.toContain('HTML version');
  });

  it('handles a missing subject', async () => {
    const { markdown } = await readEml(bytes('From: a@example.com\r\n\r\nBody only.\r\n'), deps);
    expect(markdown).toContain('# (no subject)');
  });

  it('does not render attachment bytes', async () => {
    const { markdown, json } = await readEml(bytes(withAttachment), deps);
    expect(markdown).not.toContain('BwcH');
    expect(JSON.stringify(json)).not.toContain('BwcH');
  });

  it('rejects binary junk', async () => {
    const error = await readEml(new Uint8Array([0, 1, 2, 3, 250, 251, 252]), deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DistillError);
    expect((error as DistillError).code).toBe('parse_failed');
  });
});

describe('readMsg', () => {
  it('rejects a file that is not an Outlook message', () => {
    const attempt = () => readMsg(bytes('this is not a compound file'), deps);
    expect(attempt).toThrow(DistillError);
    try {
      attempt();
    } catch (error) {
      expect((error as DistillError).code).toBe('parse_failed');
    }
  });
});

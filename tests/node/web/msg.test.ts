import { describe, expect, it, vi } from 'vitest';

const data = {
  subject: 'Quarterly numbers',
  senderName: 'Ada Lovelace',
  senderEmail: 'ada@example.com',
  body: 'Hi team,\r\n\r\nThe numbers are in.\r\n',
  messageDeliveryTime: 'Thu, 19 Nov 2026 10:00:00 GMT',
  recipients: [
    { name: 'Bob', email: 'bob@example.com', recipType: 'to' },
    { name: 'Carol', email: 'carol@example.com', recipType: 'cc' },
    { name: 'Hidden', email: 'hidden@example.com', recipType: 'bcc' },
  ],
  attachments: [{ fileName: 'numbers.xlsx', attachMimeTag: 'application/vnd.ms-excel', contentLength: 20480 }, { fileNameShort: 'x.bin', contentLength: 12 }],
};

let next: Record<string, unknown> = data;

vi.mock('@kenjiuno/msgreader', () => ({
  default: class {
    getFileData() {
      return next;
    }
  },
}));

const { readMsg } = await import('../../../src/node/web/mail');

const deps = { now: () => new Date('2026-01-02T03:04:05Z'), label: 'q.msg' };
const bytes = new Uint8Array([1, 2, 3]);

describe('readMsg with a reader', () => {
  it('uses the same output shape as eml', () => {
    next = data;
    const { markdown } = readMsg(bytes, deps);
    expect(markdown.split('\n')[0]).toBe('<!-- distill: q.msg converted 2026-01-02T03:04:05.000Z; untrusted email content -->');
    expect(markdown).toContain('# Quarterly numbers');
    expect(markdown).toContain('- From: Ada Lovelace <ada@example.com>');
    expect(markdown).toContain('- To: Bob <bob@example.com>');
    expect(markdown).toContain('- Cc: Carol <carol@example.com>');
    expect(markdown).not.toContain('hidden@example.com');
    expect(markdown).toContain('- Date: 2026-11-19T10:00:00.000Z');
    expect(markdown).toContain('The numbers are in.');
    expect(markdown).toContain('- numbers.xlsx (application/vnd.ms-excel, 20 KB)');
    expect(markdown).toContain('- x.bin (unknown type, 12 B)');
  });

  it('converts an html body when there is no text body', () => {
    next = { subject: 'Hi', senderEmail: 'a@example.com', bodyHtml: '<p>Rich <b>body</b></p>' };
    expect(readMsg(bytes, deps).markdown).toContain('Rich **body**');
  });

  it('reports a reader error', () => {
    next = { error: 'Not a valid compound file' };
    expect(() => readMsg(bytes, deps)).toThrow(/Not a valid compound file/);
  });
});

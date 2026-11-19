import { describe, expect, it } from 'vitest';
import { readMsg } from '../../../src/node/web/mail';
import { makeMsg } from '../../fixtures/make-msg';

const deps = { now: () => new Date('2026-01-02T03:04:05Z'), label: 'real.msg' };

describe('readMsg with a real compound file', () => {
  it('reads subject, sender and body from an Outlook message', () => {
    const bytes = new Uint8Array(makeMsg({ subject: 'Presupuesto Q3', senderName: 'Ada Lovelace', senderEmail: 'ada@example.com', body: 'Hola,\r\n\r\nadjunto las cifras del trimestre.\r\n' }));
    const { markdown } = readMsg(bytes, deps);
    expect(markdown).toContain('# Presupuesto Q3');
    expect(markdown).toContain('- From: Ada Lovelace <ada@example.com>');
    expect(markdown).toContain('adjunto las cifras del trimestre.');
  });
});

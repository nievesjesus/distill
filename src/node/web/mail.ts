import * as msgModule from '@kenjiuno/msgreader';
import PostalMime from 'postal-mime';
import type { Address } from 'postal-mime';
import { DistillError } from '../errors';
import { htmlFragmentToMarkdown, sourceHeader } from './extract';

const MESSAGE_HEADERS: ReadonlySet<string> = new Set(['from', 'to', 'subject', 'date', 'message-id']);

export interface MailDeps {
  now?: () => Date;
  label?: string;
}

export interface MailResult {
  markdown: string;
  pages: number;
  json: unknown;
}

interface MailParts {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  text: string;
  html: string;
  attachments: { name: string; type: string; size: number }[];
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

function mailbox(name: string | undefined, address: string | undefined): string {
  const label = (name ?? '').trim();
  const email = (address ?? '').trim();
  if (label !== '' && email !== '' && label !== email) return `${label} <${email}>`;
  return email || label;
}

function addresses(list: Address[] | Address | undefined): string {
  if (!list) return '';
  const flat = Array.isArray(list) ? list : [list];
  return flat
    .flatMap((entry) => (entry.group ? entry.group.map((member) => mailbox(member.name, member.address)) : [mailbox(entry.name, entry.address)]))
    .filter((entry) => entry !== '')
    .join(', ');
}

function isoDate(value: string | undefined): string {
  if (!value) return '';
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

function format(parts: MailParts, deps: MailDeps): string {
  const body = parts.text.trim() !== '' ? parts.text.trim() : parts.html.trim() !== '' ? htmlFragmentToMarkdown(parts.html) : '';
  const lines = [
    sourceHeader(deps.label ?? 'message', (deps.now ?? (() => new Date()))(), 'converted', 'email'),
    '',
    `# ${parts.subject.trim() || '(no subject)'}`,
    '',
    ...[
      ['From', parts.from],
      ['To', parts.to],
      ['Cc', parts.cc],
      ['Date', parts.date],
    ]
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `- ${key}: ${value}`),
  ];
  if (body !== '') lines.push('', body);
  if (parts.attachments.length > 0) {
    lines.push('', '## Attachments', '', ...parts.attachments.map((file) => `- ${file.name} (${file.type || 'unknown type'}, ${size(file.size)})`));
  }
  return `${lines.join('\n')}\n`;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === 'string' ? content.length : content.byteLength;
}

export async function readEml(bytes: Uint8Array, deps: MailDeps = {}): Promise<MailResult> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(bytes);
  } catch (error) {
    throw new DistillError('parse_failed', 'Could not read the email message', { cause: error });
  }
  const attachments = email.attachments
    .filter((file) => file.disposition !== 'inline' || file.filename)
    .map((file) => ({ name: file.filename ?? '(unnamed)', type: file.mimeType, size: byteLength(file.content) }));
  const parts: MailParts = {
    subject: email.subject ?? '',
    from: addresses(email.from),
    to: addresses(email.to),
    cc: addresses(email.cc),
    date: isoDate(email.date),
    text: email.text ?? '',
    html: email.html ?? '',
    attachments,
  };
  if (!email.headers.some((header) => MESSAGE_HEADERS.has(header.key))) {
    throw new DistillError('parse_failed', 'This file does not look like an email message');
  }
  const markdown = format(parts, deps);
  return { markdown, pages: 1, json: { format: 'eml', ...parts, markdown } };
}

type MsgCtor = new (data: ArrayBuffer | DataView) => { getFileData(): MsgData };

interface MsgData {
  error?: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  body?: string;
  bodyHtml?: string;
  messageDeliveryTime?: string;
  clientSubmitTime?: string;
  creationTime?: string;
  recipients?: { name?: string; email?: string; recipType?: string }[];
  attachments?: { fileName?: string; fileNameShort?: string; attachMimeTag?: string; contentLength?: number }[];
}

function msgReader(): MsgCtor {
  let candidate: unknown = msgModule;
  for (let depth = 0; depth < 3 && typeof candidate !== 'function'; depth++) candidate = (candidate as { default?: unknown } | undefined)?.default;
  if (typeof candidate !== 'function') throw new DistillError('parse_failed', 'The Outlook message reader is not available');
  return candidate as MsgCtor;
}

export function readMsg(bytes: Uint8Array, deps: MailDeps = {}): MailResult {
  let data: MsgData;
  try {
    const Reader = msgReader();
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    data = new Reader(copy).getFileData();
  } catch (error) {
    if (error instanceof DistillError) throw error;
    throw new DistillError('parse_failed', 'Could not read the Outlook message', { cause: error });
  }
  if (data.error) throw new DistillError('parse_failed', `Could not read the Outlook message: ${data.error}`.slice(0, 200));
  const recipients = data.recipients ?? [];
  const only = (type: string): string =>
    recipients
      .filter((entry) => (entry.recipType ?? 'to') === type)
      .map((entry) => mailbox(entry.name, entry.email))
      .filter((entry) => entry !== '')
      .join(', ');
  const parts: MailParts = {
    subject: data.subject ?? '',
    from: mailbox(data.senderName, data.senderEmail),
    to: only('to'),
    cc: only('cc'),
    date: isoDate(data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime),
    text: data.body ?? '',
    html: data.bodyHtml ?? '',
    attachments: (data.attachments ?? []).map((file) => ({
      name: file.fileName ?? file.fileNameShort ?? '(unnamed)',
      type: file.attachMimeTag ?? '',
      size: file.contentLength ?? 0,
    })),
  };
  const markdown = format(parts, deps);
  return { markdown, pages: 1, json: { format: 'msg', ...parts, markdown } };
}

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..', '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'bench', 'lib', name)).href);

const lines = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const tool = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const hook = (output: string) => ({ type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Read', output });
const toolResult = (text: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
const done = { type: 'result', subtype: 'success', is_error: false, result: 'ANSWER: 1' };

async function paths(events: object[]) {
  const { parseStream } = await load('parse.mjs');
  const { classifyPaths } = await load('classify.mjs');
  return classifyPaths(parseStream(lines([...events, done])));
}

describe('classifyPaths', () => {
  it('labels a plain Read and a Read with pages', async () => {
    expect(await paths([tool('a', 'Read', { file_path: '/p/a.pdf' })])).toEqual(['read']);
    expect(await paths([tool('a', 'Read', { file_path: '/p/a.pdf', pages: '1-3' })])).toEqual(['read-pages']);
    expect(await paths([tool('a', 'Read', { file_path: '/p/a.pdf' }), tool('b', 'Read', { file_path: '/p/a.pdf', pages: '5' })])).toEqual(['read', 'read-pages']);
  });

  it('detects a hook conversion from the hook output or the tool result', async () => {
    const converted = 'distill converted a.pdf to Markdown to save tokens. Original file: /p/a.pdf.';
    expect(await paths([tool('a', 'Read', { file_path: '/p/a.pdf' }), hook(JSON.stringify({ additionalContext: converted }))])).toEqual(['read', 'read-converted']);
    expect(await paths([tool('a', 'Read', { file_path: '/p/a.pdf', pages: '2' }), toolResult(`<system-reminder>${converted}</system-reminder>`)])).toEqual(['read-pages', 'read-converted']);
  });

  it('does not call an unrelated hook a conversion', async () => {
    expect(await paths([tool('a', 'Read', {}), hook('{"updatedInput":{"command":"rtk ls"}}')])).toEqual(['read']);
  });

  it('labels the distill MCP tools and skill calls', async () => {
    expect(await paths([tool('a', 'mcp__plugin_distill_distill__convert', { path: '/p/a.pdf' })])).toEqual(['mcp-distill']);
    expect(await paths([tool('a', 'Skill', { skill: 'distill:distill-office-documents' })])).toEqual(['skill-distill']);
    expect(await paths([tool('a', 'Bash', { command: 'npx -y distill-llm convert /p/a.docx --stdout' })])).toEqual(['skill-distill']);
    expect(await paths([tool('a', 'Bash', { command: 'distill-llm convert a.xlsx --stdout | head -50' })])).toEqual(['skill-distill']);
  });

  it('labels PDF command line tools', async () => {
    for (const command of ['pdftotext -layout a.pdf - | grep x', 'pdfinfo a.pdf', 'cd /p && mutool draw -o x.png a.pdf 1', 'qpdf --show-npages a.pdf', 'gs -sDEVICE=txtwrite -o - a.pdf', '/opt/homebrew/bin/pdftoppm -r 80 a.pdf out', 'textutil -convert txt a.docx']) {
      expect(await paths([tool('a', 'Bash', { command })])).toEqual(['bash-pdftools']);
    }
  });

  it('labels Python document libraries but not plain Python', async () => {
    expect(await paths([tool('a', 'Bash', { command: 'python3 -c "import pypdf; print(len(pypdf.PdfReader(\'a.pdf\').pages))"' })])).toEqual(['bash-python']);
    expect(await paths([tool('a', 'Bash', { command: "python3 - <<'E'\nimport openpyxl\nE" })])).toEqual(['bash-python']);
    expect(await paths([tool('a', 'Bash', { command: 'python3 -c "import fitz"' })])).toEqual(['bash-python']);
    expect(await paths([tool('a', 'Bash', { command: 'python3 -c "print(2+2)"' })])).toEqual(['bash-other']);
  });

  it('labels everything else in Bash as bash-other', async () => {
    expect(await paths([tool('a', 'Bash', { command: 'ls -la && unzip -p a.docx word/document.xml | head' })])).toEqual(['bash-other']);
  });

  it('does not match a tool name inside another word', async () => {
    expect(await paths([tool('a', 'Bash', { command: 'echo gsutil mypdftotextfile' })])).toEqual(['bash-other']);
  });

  it('combines several paths and keeps a stable order', async () => {
    const result = await paths([tool('a', 'Bash', { command: 'pdftotext a.pdf -' }), tool('b', 'Read', { file_path: 'a.pdf', pages: '1' }), tool('c', 'Bash', { command: 'ls' }), tool('d', 'Glob', { pattern: '*' })]);
    expect(result).toEqual(['read-pages', 'bash-pdftools', 'bash-other']);
  });

  it('returns nothing when no tools ran', async () => {
    expect(await paths([])).toEqual([]);
  });

  it('counts a repeated tool_use id once', async () => {
    const { parseStream } = await load('parse.mjs');
    const parsed = parseStream(lines([tool('a', 'Read', { file_path: 'x' }), tool('a', 'Read', { file_path: 'x' }), done]));
    expect(parsed.toolUses).toHaveLength(1);
  });
});

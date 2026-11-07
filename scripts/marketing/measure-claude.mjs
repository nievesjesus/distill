import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsDir = join(root, '.cache', 'marketing', 'docs');
const outFile = join(root, '.cache', 'marketing', 'claude-measured.json');
const cli = join(root, 'dist', 'cli.js');
const endpoint = 'https://api.anthropic.com/v1/messages/count_tokens';
const prompt = 'Summarize this document.';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseModel() {
  const i = process.argv.indexOf('--model');
  if (i === -1) return 'claude-sonnet-5-5';
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) fail('--model needs a model id.');
  return value;
}

function countPages(buffer) {
  const text = buffer.toString('latin1');
  const leaves = text.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  if (leaves && leaves.length > 0) return leaves.length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length > 0 ? Math.max(...counts) : 0;
}

function distillMarkdown(pdf) {
  return execFileSync('node', [cli, 'convert', pdf, '--stdout'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function countTokens(apiKey, model, content, retried = false) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) {
    if ((response.status === 429 || response.status === 529) && !retried) {
      await sleep(2000);
      return countTokens(apiKey, model, content, true);
    }
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body?.error?.message ?? message;
    } catch {
      message = response.statusText;
    }
    console.error(`Anthropic API error ${response.status}: ${message}`);
    if (response.status === 404 || response.status === 400) {
      console.error('If the model id is the problem, pass another one with --model <id>.');
    }
    process.exit(1);
  }
  const data = await response.json();
  return data.input_tokens;
}

function percent(before, after) {
  return before > 0 ? Math.round(((before - after) / before) * 100) : 0;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY to measure (only token counting is called; nothing is generated).');
    process.exit(1);
  }
  const model = parseModel();

  if (!existsSync(docsDir)) fail('No demo docs found. Run scripts/marketing/make-demo-docs.mjs first.');
  const files = readdirSync(docsDir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length === 0) fail('No PDFs in .cache/marketing/docs. Run scripts/marketing/make-demo-docs.mjs first.');

  if (!existsSync(cli)) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

  const baseline = await countTokens(apiKey, model, [{ type: 'text', text: prompt }]);

  const docs = [];
  for (const name of files) {
    const path = join(docsDir, name);
    const buffer = readFileSync(path);
    const markdown = distillMarkdown(path);
    const pdfTotal = await countTokens(apiKey, model, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: prompt },
    ]);
    const mdTotal = await countTokens(apiKey, model, [
      { type: 'text', text: markdown },
      { type: 'text', text: prompt },
    ]);
    const pdfTokens = pdfTotal - baseline;
    const markdownTokens = mdTotal - baseline;
    docs.push({ name, pages: countPages(buffer), pdfTokens, markdownTokens, saved: percent(pdfTokens, markdownTokens) });
  }

  const totalPdf = docs.reduce((sum, d) => sum + d.pdfTokens, 0);
  const totalMd = docs.reduce((sum, d) => sum + d.markdownTokens, 0);
  const result = {
    model,
    measuredAt: new Date().toISOString(),
    docs,
    total: { pdfTokens: totalPdf, markdownTokens: totalMd, saved: percent(totalPdf, totalMd) },
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');

  const width = Math.max(4, ...docs.map((d) => d.name.length));
  const row = (a, b, c, d, e) => `${a.padEnd(width)}  ${b.padStart(5)}  ${c.padStart(10)}  ${d.padStart(10)}  ${e.padStart(6)}`;
  console.log(`Model: ${model}`);
  console.log(row('File', 'Pages', 'PDF tokens', 'MD tokens', 'Saved'));
  for (const d of docs) console.log(row(d.name, String(d.pages), String(d.pdfTokens), String(d.markdownTokens), `${d.saved}%`));
  console.log(row('TOTAL', '', String(totalPdf), String(totalMd), `${result.total.saved}%`));
  console.log(`Wrote ${outFile}`);
}

main();

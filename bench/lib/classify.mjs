export const PATHS = ['read', 'read-pages', 'read-converted', 'mcp-distill', 'skill-distill', 'bash-pdftools', 'bash-python', 'bash-other'];

export const PDF_TOOLS = ['pdftotext', 'pdfinfo', 'pdftoppm', 'pdfimages', 'pdftohtml', 'mutool', 'qpdf', 'gs', 'textutil'];

const PDF_TOOLS_PATTERN = new RegExp(`(^|[\\s;&|(\`/])(${PDF_TOOLS.join('|')})(?=$|[\\s;&|)\`])`);
const PYTHON_PATTERN = /(^|[\s;&|(`/])(python3?|python3\.\d+)(?=$|[\s;&|)`])|\bpip3?\s+install\b/;
const PYTHON_DOC_LIBS = /pdf|pypdf|fitz|pymupdf|docx|openpyxl|xlrd|pptx|pandas/i;
const DISTILL_CLI = /distill-llm(@\S+)?\s+convert|distill-llm\s+(outline|--stdout)/;

export function classifyBash(command) {
  const labels = new Set();
  if (typeof command !== 'string') return labels;
  if (DISTILL_CLI.test(command)) labels.add('skill-distill');
  if (PDF_TOOLS_PATTERN.test(command)) labels.add('bash-pdftools');
  if (PYTHON_PATTERN.test(command) && PYTHON_DOC_LIBS.test(command)) labels.add('bash-python');
  if (labels.size === 0) labels.add('bash-other');
  return labels;
}

export function classifyPaths(parsed) {
  const labels = new Set();
  for (const use of parsed.toolUses ?? []) {
    if (use.name === 'Read') {
      labels.add(use.input?.pages !== undefined && use.input.pages !== null && use.input.pages !== '' ? 'read-pages' : 'read');
    } else if (use.name === 'Bash') {
      for (const label of classifyBash(use.input?.command)) labels.add(label);
    } else if (/^mcp__.*distill/i.test(use.name)) {
      labels.add('mcp-distill');
    } else if (use.name === 'Skill' && /distill/i.test(JSON.stringify(use.input ?? {}))) {
      labels.add('skill-distill');
    }
  }
  if (parsed.converted === true) labels.add('read-converted');
  return PATHS.filter((label) => labels.has(label));
}

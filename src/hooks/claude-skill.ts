import { join } from 'node:path';

export const CLAUDE_SKILL_NAME = 'distill-office-documents';

export const SKILL_MARKER = '<!-- distill-llm skill -->';

export function claudeSkillPath(base: string): string {
  return join(base, '.claude', 'skills', CLAUDE_SKILL_NAME, 'SKILL.md');
}

export function isOwnSkill(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === SKILL_MARKER);
}

export function claudeSkillMarkdown(command: string): string {
  return `---
name: ${CLAUDE_SKILL_NAME}
description: Use when you need to read a Word, Excel, PowerPoint or OpenDocument file (.docx, .doc, .xlsx, .xls, .pptx, .ppt, .odt, .ods, .odp). The Read tool cannot open these files; this converts them to token-lean Markdown locally.
---
${SKILL_MARKER}

# Read Office documents as Markdown

The Read tool cannot open Word, Excel, PowerPoint or OpenDocument files. Convert them with the Bash tool instead:

\`\`\`bash
${command} convert --stdout --max-tokens 8000 "<path>"
\`\`\`

- Read the Markdown the command prints.
- If the output starts with an index ("Index of ..."), the document is large: read only the sections you need by running the command again with \`--offset <line> --limit <lines>\` instead of \`--max-tokens\`, using the line numbers from the index.
- Convert one file per call.
- Exit code 1 means the conversion failed; the message on stderr says why (for example the file is password-protected, or it is a .doc, .xls, .ppt or OpenDocument file and LibreOffice is missing).
- For PDFs just use Read; the distill hook handles them.
`;
}

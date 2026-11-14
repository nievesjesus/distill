import { join } from 'node:path';

export const CLAUDE_SKILL_NAME = 'distill-office-documents';

const MARKER = '<!-- distill-llm skill -->';

export function claudeSkillPath(base: string): string {
  return join(base, '.claude', 'skills', CLAUDE_SKILL_NAME, 'SKILL.md');
}

export function isOwnSkill(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === MARKER);
}

export function claudeSkillMarkdown(command: string): string {
  return `---
name: ${CLAUDE_SKILL_NAME}
description: Use when you need to read a Word, Excel, PowerPoint or OpenDocument file (.docx, .doc, .xlsx, .xls, .pptx, .ppt, .odt, .ods, .odp). The Read tool cannot open these files; this converts them to token-lean Markdown locally.
---
${MARKER}

# Read Office documents as Markdown

The Read tool cannot open Word, Excel, PowerPoint or OpenDocument files. Convert them with the Bash tool instead:

\`\`\`bash
${command} convert --stdout "<path>"
\`\`\`

- Read the Markdown the command prints.
- Convert one file per call.
- Exit code 1 means the conversion failed; the message on stderr says why (for example LibreOffice is missing or the file is password-protected).
- For PDFs just use Read; the distill hook handles them.
`;
}

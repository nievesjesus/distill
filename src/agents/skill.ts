import { join } from 'node:path';
import { SKILL_MARKER } from '../hooks/claude-skill';

export const AGENTS_SKILL_NAME = 'distill-documents';

export function agentsSkillPath(base: string): string {
  return join(base, '.agents', 'skills', AGENTS_SKILL_NAME, 'SKILL.md');
}

export function hermesSkillPath(home: string): string {
  return join(home, '.hermes', 'skills', AGENTS_SKILL_NAME, 'SKILL.md');
}

export function agentsSkillMarkdown(command: string): string {
  return `---
name: ${AGENTS_SKILL_NAME}
description: Use whenever you need to read a PDF, DOCX, XLSX, PPTX, legacy Office (.doc, .xls, .ppt) or OpenDocument (.odt, .ods, .odp) file. These files cannot be read as plain text; this converts them locally to token-lean Markdown.
---
${SKILL_MARKER}

# Read documents as Markdown

Convert the file with a shell command instead of opening it directly:

\`\`\`bash
${command} convert --stdout --max-tokens 8000 "<path>"
\`\`\`

- Read the Markdown the command prints.
- If the output starts with an index ("Index of ..."), the document is large: read only the sections you need by running the command again with \`--offset <line> --limit <lines>\` instead of \`--max-tokens\`, using the line numbers from the index.
- Convert one file per call.
- Pages marked figure in the Markdown contain charts or images that are not in the text; if the question depends on them, look at that page in the original.
- Exit code 1 means the conversion failed; the message on stderr says why (for example the file is password-protected, or it is a .doc, .xls, .ppt or OpenDocument file and LibreOffice is missing).
- The conversion runs locally. Never upload the file to any service to read it.
`;
}

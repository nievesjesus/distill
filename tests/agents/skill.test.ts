import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwnSkill } from '../../src/hooks/claude-skill';
import { AGENTS_SKILL_NAME, agentsSkillMarkdown, agentsSkillPath, hermesSkillPath } from '../../src/agents/skill';

describe('portable agents skill', () => {
  const text = agentsSkillMarkdown('distill-llm');

  it('has front matter with the name and a description listing every format', () => {
    expect(AGENTS_SKILL_NAME).toBe('distill-documents');
    expect(text.startsWith('---\nname: distill-documents\ndescription: ')).toBe(true);
    const description = text.split('\n')[2] ?? '';
    for (const word of ['PDF', 'DOCX', 'XLSX', 'PPTX', '.doc', '.xls', '.ppt', 'OpenDocument']) {
      expect(description).toContain(word);
    }
    expect(description).toMatch(/whenever/i);
  });

  it('carries the marker so it is recognized as our own', () => {
    expect(isOwnSkill(text)).toBe(true);
    expect(isOwnSkill('# my skill')).toBe(false);
  });

  it('runs the resolved command with stdout and a token budget', () => {
    expect(text).toContain('distill-llm convert --stdout --max-tokens 8000 "<path>"');
    expect(agentsSkillMarkdown('node /opt/d/cli.js')).toContain('node /opt/d/cli.js convert --stdout --max-tokens 8000 "<path>"');
  });

  it('documents the index, the failure exit code and never uploading', () => {
    expect(text).toContain('--offset');
    expect(text).toContain('--limit');
    expect(text).toMatch(/exit code 1/i);
    expect(text).toMatch(/stderr/);
    expect(text).toMatch(/never upload/i);
  });

  it('points at search before reading a long document whole', () => {
    expect(text).toContain('distill-llm grep "<query>" "<path>"');
    expect(agentsSkillMarkdown('node /opt/d/cli.js')).toContain('node /opt/d/cli.js grep "<query>" "<path>"');
    expect(text).toContain('p.<page> L<line>');
    expect(text).toContain('distill_search');
  });

  it('tells the agent about figure pages', () => {
    expect(text).toContain('figure');
  });

  it('contains no comments other than the marker', () => {
    expect(text.replace('<!-- distill-llm skill -->', '')).not.toMatch(/<!--|\/\/|\/\*/);
  });

  it('resolves the shared, hermes and project locations', () => {
    expect(agentsSkillPath('/h')).toBe(join('/h', '.agents', 'skills', 'distill-documents', 'SKILL.md'));
    expect(agentsSkillPath('/c')).toBe(join('/c', '.agents', 'skills', 'distill-documents', 'SKILL.md'));
    expect(hermesSkillPath('/h')).toBe(join('/h', '.hermes', 'skills', 'distill-documents', 'SKILL.md'));
  });
});

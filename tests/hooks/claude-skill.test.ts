import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSkillMarkdown, claudeSkillPath, isOwnSkill } from '../../src/hooks/claude-skill';

describe('claude skill', () => {
  it('renders a skill with front matter and the command', () => {
    const text = claudeSkillMarkdown('distill-llm');
    expect(text.startsWith('---\nname: distill-office-documents\n')).toBe(true);
    expect(text).toContain('distill-llm convert --stdout');
    expect(isOwnSkill(text)).toBe(true);
  });

  it('does not claim foreign skills', () => {
    expect(isOwnSkill('# my skill')).toBe(false);
  });

  it('places the skill under .claude/skills', () => {
    expect(claudeSkillPath('/h')).toBe(join('/h', '.claude', 'skills', 'distill-office-documents', 'SKILL.md'));
  });
});

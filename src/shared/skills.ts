/**
 * Skill file loader.
 *
 * Loads Agent 06's wiki skills from `.claude/skills/*.md` at module load,
 * strips YAML frontmatter, and exposes them as constants for injection into
 * LLM prompts.
 *
 * Owner: Tuan (Agent 06 sub-agents consume this). Lives in `src/shared/`
 * because both `tx-classifier/llm-fallback.ts` and `nl-query/llm-translator.ts`
 * use the same loader. If a second Credio agent ever needs a different
 * skill-loading pattern, refactor at that point.
 *
 * Failure mode: throws on missing/unreadable skill file. We do NOT silently
 * fall back to inline text — the whole point of this loader is to make
 * `.claude/skills/` the single source of truth.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILLS_DIR = resolve(process.cwd(), '.claude/skills');

function readSkill(filename: string): string {
  return readFileSync(resolve(SKILLS_DIR, filename), 'utf-8');
}

/** Strip the leading `--- ... ---` YAML frontmatter block. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1]!.trim() : content;
}

const CLASSIFICATION_BODY = stripFrontmatter(
  readSkill('celo-tx-classification.md'),
);
const REGULATORY_BODY = stripFrontmatter(
  readSkill('nigeria-kenya-crypto-tax.md'),
);

export const SKILLS = {
  /** Transaction classification taxonomy + rules. Source: celo-tx-classification.md */
  classification: {
    body: CLASSIFICATION_BODY,
    source: '.claude/skills/celo-tx-classification.md',
  },
  /** Nigeria FIRS + Kenya KRA crypto tax rules. Source: nigeria-kenya-crypto-tax.md */
  regulatory: {
    body: REGULATORY_BODY,
    source: '.claude/skills/nigeria-kenya-crypto-tax.md',
  },
} as const;

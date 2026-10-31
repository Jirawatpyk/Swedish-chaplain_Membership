/**
 * `check:process-docs` — the review rules have ONE owner, `review-and-ship`
 * § 1 (D-043). On #714 the same rules were restated in seven files and three
 * copies were missed (retro 2026-10-31); this gate fails when a rule's text
 * reappears outside its owner.
 */
import { describe, expect, it } from 'vitest';

import {
  findProcessDocViolations,
  REVIEW_RULE_PHRASES,
  REVIEW_RULES_OWNER,
  type DocFile,
} from '../../../scripts/lib/process-docs';

const owner = (extra = ''): DocFile => ({
  path: REVIEW_RULES_OWNER,
  text: REVIEW_RULE_PHRASES.join('\n') + extra,
});

describe('findProcessDocViolations', () => {
  it('flags a rule phrase restated outside its owner (positive control)', () => {
    const phrase = REVIEW_RULE_PHRASES[0]!;
    const v = findProcessDocViolations([owner(), { path: 'docs/workflow.md', text: `x ${phrase} y` }]);
    expect(v.restated).toEqual([{ path: 'docs/workflow.md', phrase }]);
    expect(v.missingFromOwner).toEqual([]);
  });

  it('passes when only the owner carries the rules and others link to it', () => {
    const v = findProcessDocViolations([
      owner(),
      { path: 'docs/workflow.md', text: 'No High or Medium remains (`review-and-ship` § 1).' },
    ]);
    expect(v).toEqual({ restated: [], missingFromOwner: [] });
  });

  it('fails when the owner no longer carries a phrase, so the gate is never inert', () => {
    const [first, ...rest] = REVIEW_RULE_PHRASES;
    const v = findProcessDocViolations([{ path: REVIEW_RULES_OWNER, text: rest.join('\n') }]);
    expect(v.missingFromOwner).toEqual([first]);
  });

  it('fails when the owner file is not in the scanned set at all', () => {
    const v = findProcessDocViolations([{ path: 'docs/workflow.md', text: 'nothing' }]);
    expect(v.missingFromOwner).toEqual([...REVIEW_RULE_PHRASES]);
  });

  it('matches across a line break and CRLF, so a wrapped restatement is still caught', () => {
    const phrase = REVIEW_RULE_PHRASES[0]!;
    const wrapped = phrase.replace(' ', '\r\n');
    const v = findProcessDocViolations([owner(), { path: '.claude/skills/feature-flow/SKILL.md', text: wrapped }]);
    expect(v.restated.map((r) => r.path)).toEqual(['.claude/skills/feature-flow/SKILL.md']);
  });

  it('ignores the decision log, the retro log, the changelog and specs (history, not restatement)', () => {
    const phrase = REVIEW_RULE_PHRASES[0]!;
    const v = findProcessDocViolations([
      owner(),
      { path: 'docs/decisions.md', text: phrase },
      { path: 'docs/retro.md', text: phrase },
      { path: 'docs/changelog.md', text: phrase },
      { path: 'specs/140-eblast-one-leg/plan.md', text: phrase },
    ]);
    expect(v.restated).toEqual([]);
  });
});

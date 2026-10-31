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

  it('ignores the decision log, the retro log and the changelog (history, not restatement)', () => {
    const phrase = REVIEW_RULE_PHRASES[0]!;
    const v = findProcessDocViolations([
      owner(),
      { path: 'docs/decisions.md', text: phrase },
      { path: 'docs/retro.md', text: phrase },
      { path: 'docs/changelog.md', text: phrase },
    ]);
    expect(v.restated).toEqual([]);
  });

  // Real restatements, copied from the files as they stood on main at
  // e6d82d0c8 (#714). The first version of this gate let every one of them
  // through (review round 1 on #715), so they are the positive controls.
  const REAL_OWNER: DocFile = {
    path: REVIEW_RULES_OWNER,
    text: [
      '  - it is refuted with evidence, and the reviewer confirms that on a re-run;',
      '  - for an L slice only, a **Medium** is **carried to the slice that owns it** (D-043). A High is never carried, because every merge deploys.',
      '  - "Already" means in the agreed plan: `plan.md` at this branch\'s base commit (`git show $(git merge-base origin/main HEAD):specs/<nnn-name>/plan.md`). *k*\'s row in § Slices must name the concern **in words**; an ID alone (such as `DT3`) does not count.',
      '- **A docs-only change gets no `/code-review`** (D-043).',
      '- **From round 3 on, each round is targeted** (D-043).',
      '  - Tell it not to pad to a minimum count. An empty list is a valid answer.',
      '  - A **decided item** is a finding already closed.',
      '  - size L, or any sensitive surface: the ≥ 2 full rounds above plus at most 2 targeted rounds.',
    ].join('\n'),
  };

  it.each([
    [
      'workflow.md step 7 closures',
      'A finding closes when it is fixed, when it is refuted with evidence and the reviewer confirms on a re-run, or (for a Medium in an L slice) when it is carried',
    ],
    [
      'workflow.md step 7 rounds, lower-case docs-only',
      'From round 3 on, a round reviews only the fix commits; rounds are capped by size, and at the cap the maintainer decides the open findings; a docs-only change gets no `/code-review` (D-043).',
    ],
    [
      "the auditor's copied carry condition",
      "slice *k* names the concern in the agreed plan: `plan.md` at this branch's base commit (`git show $(git merge-base origin/main HEAD):specs/<nnn-name>/plan.md`). *k*'s row in § Slices must name the concern **in words**; an ID alone (such as `DT3`) does not count;",
    ],
    ['a decided item without the bold markers', 'A decided item is a finding already closed by one of the closures.'],
  ])('catches a real restatement: %s', (_label, text) => {
    const v = findProcessDocViolations([REAL_OWNER, { path: 'docs/workflow.md', text }]);
    expect(v.missingFromOwner).toEqual([]);
    expect(v.restated.length).toBeGreaterThan(0);
  });
});

/**
 * The review rules have ONE owner (D-043): `review-and-ship` § 1. Every other
 * process file links to it instead of restating it. On #714 the rules were
 * written into seven files and three copies were missed (retro 2026-10-31).
 *
 * The check is a phrase list: a short sentence from each rule that a
 * restatement would have to repeat. A phrase found outside the owner is a
 * restatement; a phrase missing from the owner means the rule was reworded
 * and this list must follow it, so the gate can never go quietly inert.
 */
export interface DocFile {
  readonly path: string;
  readonly text: string;
}

export const REVIEW_RULES_OWNER = '.claude/skills/review-and-ship/SKILL.md';

/** One sentence per rule, copied exactly from the owner. */
export const REVIEW_RULE_PHRASES: readonly string[] = [
  'and the reviewer confirms that on a re-run',
  'A High is never carried',
  'From round 3 on, each round is targeted',
  'An empty list is a valid answer',
  'A **decided item** is',
  'at most 2 targeted rounds',
  'A docs-only change gets no',
];

/** History, not restatement: these record what was decided or done. */
const EXEMPT = [/^docs\/decisions\.md$/, /^docs\/retro\.md$/, /^docs\/changelog\.md$/, /^specs\//];

// Whitespace (including a CRLF line break inside a wrapped sentence) collapses
// to one space on both sides, so a restatement cannot hide behind a line wrap.
const norm = (s: string) => s.replace(/\s+/g, ' ');

export interface ProcessDocViolations {
  readonly restated: ReadonlyArray<{ readonly path: string; readonly phrase: string }>;
  readonly missingFromOwner: readonly string[];
}

export function findProcessDocViolations(files: readonly DocFile[]): ProcessDocViolations {
  const ownerFile = files.find((f) => f.path === REVIEW_RULES_OWNER);
  const ownerText = ownerFile === undefined ? '' : norm(ownerFile.text);
  const missingFromOwner = REVIEW_RULE_PHRASES.filter((p) => !ownerText.includes(norm(p)));
  const restated: Array<{ path: string; phrase: string }> = [];
  for (const f of files) {
    if (f.path === REVIEW_RULES_OWNER || EXEMPT.some((re) => re.test(f.path))) continue;
    const text = norm(f.text);
    for (const phrase of REVIEW_RULE_PHRASES) {
      if (text.includes(norm(phrase))) restated.push({ path: f.path, phrase });
    }
  }
  return { restated, missingFromOwner };
}

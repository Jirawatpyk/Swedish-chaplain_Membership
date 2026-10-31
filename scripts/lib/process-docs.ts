/**
 * The review rules have ONE owner (D-043): `review-and-ship` § 1. Every other
 * process file links to it instead of restating it. On #714 the rules were
 * written into seven files and three copies were missed (retro 2026-10-31).
 *
 * The check is a phrase list: a short piece of each rule that a restatement
 * would have to repeat. A phrase found outside the owner is a restatement; a
 * phrase missing from the owner means the rule was reworded and this list
 * must follow it, so the gate can never go quietly inert.
 *
 * It catches copies and near-copies (case, Markdown emphasis and line wraps
 * are ignored). A true paraphrase still needs a reader.
 */
export interface DocFile {
  readonly path: string;
  readonly text: string;
}

export const REVIEW_RULES_OWNER = '.claude/skills/review-and-ship/SKILL.md';

/**
 * Pieces of the owner's rules, in the normalised form `norm()` produces:
 * lower case, no `*`, backticks or `_`, single spaces. Each was checked
 * against the restatements found on main at e6d82d0c8 (#714).
 */
export const REVIEW_RULE_PHRASES: readonly string[] = [
  // How a finding closes.
  'refuted with evidence',
  'a high is never carried',
  // The carry conditions (the auditor once copied these word for word).
  // (Not `git merge-base origin/main head` alone: whole-branch-reviewer uses
  // that command for its own diff base, which is not a restatement.)
  "at this branch's base commit",
  'an id alone',
  // Rounds, the cap, the stop rule.
  'from round 3 on',
  'an empty list is a valid answer',
  'a decided item is',
  'at most 2 targeted rounds',
  // Docs-only changes.
  'docs-only change gets no',
];

export const VERIFY_RULES_OWNER = '.claude/skills/feature-flow/SKILL.md';

/** The Verify rule (D-044), owned by `feature-flow` § 6. */
export const VERIFY_RULE_PHRASES: readonly string[] = [
  'claude cannot invoke /verify',
  'no hand-driving',
  'no surface, no /verify',
  'leave nothing undeletable at the provider',
];

/** Each rule set: one owner file, and the pieces only it may carry. */
export const RULE_SETS: ReadonlyArray<{ readonly owner: string; readonly phrases: readonly string[] }> = [
  { owner: REVIEW_RULES_OWNER, phrases: REVIEW_RULE_PHRASES },
  { owner: VERIFY_RULES_OWNER, phrases: VERIFY_RULE_PHRASES },
];

/** History, not restatement: these record what was decided or done. */
const EXEMPT = [/^docs\/decisions\.md$/, /^docs\/retro\.md$/, /^docs\/changelog\.md$/];

// Lower-case, drop Markdown emphasis and code marks, and collapse whitespace
// (including a CRLF line break inside a wrapped sentence), so a near-copy
// cannot hide behind case, bold or a line wrap.
const norm = (s: string) => s.toLowerCase().replace(/[*`_]/g, '').replace(/\s+/g, ' ');

export interface ProcessDocViolations {
  readonly restated: ReadonlyArray<{ readonly path: string; readonly phrase: string }>;
  readonly missingFromOwner: readonly string[];
}

export function findProcessDocViolations(files: readonly DocFile[]): ProcessDocViolations {
  const missingFromOwner: string[] = [];
  const restated: Array<{ path: string; phrase: string }> = [];
  for (const set of RULE_SETS) {
    const ownerFile = files.find((f) => f.path === set.owner);
    const ownerText = ownerFile === undefined ? '' : norm(ownerFile.text);
    missingFromOwner.push(...set.phrases.filter((p) => !ownerText.includes(norm(p))));
    for (const f of files) {
      if (f.path === set.owner || EXEMPT.some((re) => re.test(f.path))) continue;
      const text = norm(f.text);
      for (const phrase of set.phrases) {
        if (text.includes(norm(phrase))) restated.push({ path: f.path, phrase });
      }
    }
  }
  return { restated, missingFromOwner };
}

/**
 * 108 T102 (US1, FR-008, SC-001) — F8 reminder dispatch keeps resolving the
 * primary contact LIVE.
 *
 * F8 was already correct when 108 started: its three candidate queries
 * (reminder, due-track, tier-upgrade) join `contacts` on
 * `is_primary = true AND removed_at IS NULL` and read it at dispatch time, so a
 * promotion is honoured by the next reminder. 108 changed the money paths to
 * match — which makes F8 the reference implementation, and reference
 * implementations are exactly what quietly drifts: nothing in F4's test suite
 * would notice if a future edit dropped `removed_at` from one of these three
 * joins and started mailing renewal notices to a removed contact.
 *
 * This is a SOURCE-level guard, not a behavioural one. That is a deliberate
 * trade: a live-Neon test of all three candidate paths needs renewal cycles,
 * policies, plans and clock control per path, and it would still only prove the
 * paths it seeded. Reading the predicate is cheap, total, and fails on the exact
 * edit that would cause the regression. The behavioural coverage for these paths
 * lives in `tests/integration/renewals/`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { stripCommentLines } from '../../../scripts/lib/source-scan';

const REPO_ROOT = resolvePath(__dirname, '../../..');
const REPO_FILE =
  'src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts';

/** The three candidate queries: reminder, due-track, tier-upgrade. */
const EXPECTED_PRIMARY_JOINS = 3;

/**
 * Comment-stripped, like every other source-reading gate here. Reading raw
 * would make a prose mention of `primary_contact_email` fail the last
 * assertion, and a commented-out join inflate the count — a guard that can be
 * reddened by a comment teaches people to stop writing comments.
 */
function source(): string {
  return stripCommentLines(readFileSync(resolvePath(REPO_ROOT, REPO_FILE), 'utf8')).join(
    String.fromCharCode(10),
  );
}

describe('F8 dispatch candidates — live primary contact (108 FR-008)', () => {
  it('has exactly the three known primary-contact joins', () => {
    const matches = [...source().matchAll(/eq\(\s*contacts\.isPrimary,\s*true\s*\)/g)];
    // A 4th appearing means a new candidate path was added — read it and either
    // bump this number (with the predicate below satisfied) or fix the join.
    expect(matches).toHaveLength(EXPECTED_PRIMARY_JOINS);
  });

  it('every one of them also excludes removed contacts', () => {
    const lines = source().split(/\r?\n/);
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/eq\(\s*contacts\.isPrimary,\s*true\s*\)/.test(line)) return;
      // The predicate sits on an adjacent line in every existing site; allow a
      // small window so a reformat does not fail the gate spuriously.
      const window = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
      if (!/contacts\.removedAt\}?\s*IS NULL|isNull\(\s*contacts\.removedAt\s*\)/.test(window)) {
        offenders.push(`${REPO_FILE}:${i + 1}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('reads contacts at dispatch time, not from a frozen snapshot', () => {
    // The money-path bug in one sentence: an address copied at issue and reused
    // forever. F8 must never grow that habit — it has no snapshot to read from,
    // and this asserts it stays that way.
    expect(source()).not.toContain('primary_contact_email');
    expect(source()).not.toContain('memberIdentitySnapshot');
  });
});

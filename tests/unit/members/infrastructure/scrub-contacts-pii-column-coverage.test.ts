/**
 * COMP-1 US1 (Member Erasure) — allowlist guard for the `contacts` PII scrub.
 *
 * Mirror of the `members` guard (scrub-pii-column-coverage.test.ts): the
 * `scrubPiiForMemberInTx` cascade uses a DENYLIST (an explicit `.set({...})` of
 * columns to anonymise). A denylist is fragile — any column added to the
 * `contacts` schema in a future feature is SILENTLY left un-scrubbed, leaking
 * PII through `eraseMember`'s contact cascade with no signal.
 *
 * This test inverts the contract into an ALLOWLIST: it enumerates the ACTUAL
 * `contacts` table columns from the Drizzle table object via `getTableColumns`
 * and asserts that the full column set is partitioned EXACTLY into two
 * hand-maintained sets:
 *
 *   • SCRUBBED — anonymised (sentinel/NULL/'en'/false) by `scrubPiiForMemberInTx`,
 *     plus the `removed_at`/`updated_at` stamps it writes.
 *   • KEPT     — intentionally retained (identity, parent binding, F1 user
 *     binding deferred to US2, low-PII timestamp), each with a one-word rationale.
 *
 * A NEW column then fails this test (it is in neither set) until a maintainer
 * consciously classifies it as SCRUBBED or KEPT — closing the silent-drift hole.
 * Both sets are hardcoded HERE as the source of truth (drizzle prop names);
 * they must stay in lock-step with the `.set({...})` in drizzle-contact-repo.ts.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';

// Columns anonymised by `scrubPiiForMemberInTx` (sentinel / NULL / 'en' / false)
// + the two stamps it writes. Keep in lock-step with the `.set({...})` in
// drizzle-contact-repo.ts.
const SCRUBBED = new Set<string>([
  // Direct identifiers / free-text PII.
  'firstName', // → '[erased]' sentinel (NOT NULL)
  'lastName', // → '[erased]' sentinel (NOT NULL)
  'email', // → per-row sentinel built from contact_id (NOT NULL + unique index)
  'phone', // → NULL
  'dateOfBirth', // → NULL (collected only for Thai Alumni)
  'roleTitle', // → NULL
  // Non-PII fields the scrub also resets to break linkability / satisfy constraints.
  'preferredLanguage', // → 'en' (NOT NULL default)
  'isPrimary', // → false (leaves the one-primary partial index + CHECK)
  // Stamps written by the scrub itself.
  'removedAt', // stamped so the row leaves the active-email unique index
  'updatedAt',
]);

// Columns intentionally retained by `scrubPiiForMemberInTx`. Rationale (one word):
const KEPT = new Set<string>([
  'tenantId', // tenancy
  'contactId', // identity
  'memberId', // binding (parent member)
  'createdAt', // record-keeping
  'linkedUserId', // F1-binding (erasure deferred to US2 — retained intentionally)
  'inviteBouncedAt', // low-PII timestamp (no identifier, just a bounce marker)
]);

describe('contacts scrub — column-coverage allowlist guard (COMP-1 US1)', () => {
  const actualColumns = Object.keys(getTableColumns(contacts));

  it('partitions every contacts column into exactly SCRUBBED ∪ KEPT', () => {
    const classified = new Set<string>([...SCRUBBED, ...KEPT]);
    const actual = new Set(actualColumns);

    // (1) No column is in BOTH sets (disjoint partition).
    const inBoth = [...SCRUBBED].filter((c) => KEPT.has(c));
    expect(inBoth, `columns classified as BOTH scrubbed and kept: ${inBoth.join(', ')}`).toEqual([]);

    // (2) No unclassified column — a NEW schema column fails here until a
    //     maintainer puts it in SCRUBBED or KEPT.
    const unclassified = actualColumns.filter((c) => !classified.has(c));
    expect(
      unclassified,
      `unclassified contacts columns — add each to SCRUBBED or KEPT in this test AND (if PII) to scrubPiiForMemberInTx: ${unclassified.join(', ')}`,
    ).toEqual([]);

    // (3) No stale entry — a removed column must drop out of the sets.
    const stale = [...classified].filter((c) => !actual.has(c));
    expect(stale, `stale columns in SCRUBBED/KEPT no longer on the contacts table: ${stale.join(', ')}`).toEqual([]);
  });

  it('the SCRUBBED set covers the direct-identifier PII columns', () => {
    // Regression pin: the free-text / contact PII the cascade anonymises must
    // stay scrubbed.
    for (const col of [
      'firstName',
      'lastName',
      'email',
      'phone',
      'dateOfBirth',
      'roleTitle',
    ]) {
      expect(SCRUBBED.has(col), `${col} must be in the SCRUBBED set`).toBe(true);
    }
  });
});

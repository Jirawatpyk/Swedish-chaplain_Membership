/**
 * COMP-1 US1 (Member Erasure) — allowlist guard for the `members` PII scrub.
 *
 * The altitude fix for the H1 code-review finding: `scrubPiiInTx` uses a
 * DENYLIST (an explicit `.set({...})` of columns to anonymise). A denylist is
 * fragile — any column added to the `members` schema in a future feature is
 * SILENTLY left un-scrubbed, leaking PII through `eraseMember` with no signal.
 *
 * This test inverts the contract into an ALLOWLIST: it enumerates the ACTUAL
 * `members` table columns from the Drizzle table object via `getTableColumns`
 * and asserts that the full column set is partitioned EXACTLY into two
 * hand-maintained sets:
 *
 *   • SCRUBBED — anonymised (sentinel/NULL) by `scrubPiiInTx`, plus the
 *     `erased_at`/`updated_at` stamps it writes.
 *   • KEPT     — intentionally retained (identity, non-PII state/flags,
 *     low-re-identification aggregates), each with a one-word rationale.
 *
 * A NEW column then fails this test (it is in neither set) until a maintainer
 * consciously classifies it as SCRUBBED or KEPT — closing the silent-drift hole.
 * Both sets are hardcoded HERE as the source of truth (drizzle prop names);
 * they must stay in lock-step with the `.set({...})` in `drizzle-member-repo.ts`.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { members } from '@/modules/members/infrastructure/db/schema-members';

// Columns anonymised by `scrubPiiInTx` (sentinel or NULL) + the two stamps it
// writes. Keep in lock-step with the `.set({...})` in drizzle-member-repo.ts.
const SCRUBBED = new Set<string>([
  // Direct identifiers / free-text PII (F3 era).
  'companyName', // → '[erased]' sentinel (NOT NULL)
  'legalEntityType',
  'taxId',
  'website',
  'description',
  'notes',
  // Business quasi-identifiers (GDPR Recital 26 at small-chamber scale).
  'foundedYear',
  'turnoverThb',
  // 088 US3 — §86/4 Head-Office / Branch particular (business quasi-identifier).
  // Reset to the head-office DEFAULT on erasure: `is_head_office` → TRUE,
  // `branch_code` → NULL (drops the RD branch identifier; the pair stays CHECK-
  // consistent, head office ⇒ NULL code).
  'isHeadOffice',
  'branchCode',
  // §86/4 business quasi-identifier, same class as isHeadOffice/branchCode.
  // Reset to its DEFAULT (false) on erasure, not NULL — the column is NOT NULL,
  // and `false` is also what keeps the tightened branch-pairing CHECK satisfied
  // (a non-registrant cannot be a branch).
  'isVatRegistered',
  // Postal address.
  'addressLine1',
  'addressLine2',
  'city',
  'province',
  'postalCode',
  // Postal address (PII). แขวง/ตำบล — the Thai sub-district level; part of
  // the §86/4 buyer address frozen onto the tax document at issue.
  'subDistrict',
  // Business quasi-identifier (GDPR Recital 26 at small-chamber scale) —
  // same class as turnoverThb / foundedYear.
  'registeredCapitalThb',
  // F8-era admin free-text + behavioral/financial risk cluster (H1 additions).
  // The blocked-reactivation cluster scrubs AS A UNIT: the 0094 consistency
  // CHECK forbids `blocked=TRUE` once the provenance (`set_by_user_id`) is
  // nulled, so the flag + `..._at` collapse to FALSE/NULL with the reason+actor.
  'blockedFromAutoReactivation', // flag — collapses to FALSE (CHECK consistency)
  'blockedFromAutoReactivationAt', // collapses to NULL with the flag
  'blockedFromAutoReactivationReason', // admin free-text (can name/email the member)
  'blockedFromAutoReactivationSetByUserId', // admin who blocked — part of the erased record
  'riskScore', // derived quasi-identifier
  'riskScoreBand',
  'riskScoreFactors', // jsonb derived behavioral/financial signals
  'riskScoreLastComputedAt', // computed time for a now-deleted score — moot
  'riskSnoozedUntil', // snooze time for a now-deleted score — moot
  // Stamps written by the scrub itself.
  'erasedAt',
  'updatedAt',
]);

// Columns intentionally retained by `scrubPiiInTx`. Rationale (one word):
const KEPT = new Set<string>([
  'tenantId', // tenancy
  'memberId', // identity
  'memberNumber', // identity
  'planId', // binding
  'planYear', // binding
  'registrationDate', // record-keeping
  'registrationFeePaid', // record-keeping
  'createdAt', // record-keeping
  'country', // low-re-identification (2-letter ISO, useful aggregate)
  'preferredLocale', // UX-setting
  'status', // state (erasure is orthogonal to archive)
  'archivedAt', // state
  'lastActivityAt', // state
  // 065 §5.1 — per-member billing cadence ('calendar' | 'rolling'). NOT PII:
  // a 2-value operational setting with zero re-identification value (same class
  // as `status` / `preferredLocale`). Retained on erasure; the column is NOT
  // NULL so nulling it is impossible anyway.
  'billingCycle', // operational-setting

  // Non-identifying boolean flags + their consent/record timestamps.
  'renewalRemindersOptedOut', // flag
  'renewalRemindersOptedOutAt', // record-keeping
  'emailUnverified', // flag
  'emailUnverifiedAt', // record-keeping
  'broadcastsHaltedUntilAdminReview', // flag
  'broadcastsAcknowledgedAt', // consent-record
]);

describe('members scrub — column-coverage allowlist guard (COMP-1 H1)', () => {
  const actualColumns = Object.keys(getTableColumns(members));

  it('partitions every members column into exactly SCRUBBED ∪ KEPT', () => {
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
      `unclassified members columns — add each to SCRUBBED or KEPT in this test AND (if PII) to scrubPiiInTx: ${unclassified.join(', ')}`,
    ).toEqual([]);

    // (3) No stale entry — a removed column must drop out of the sets.
    const stale = [...classified].filter((c) => !actual.has(c));
    expect(stale, `stale columns in SCRUBBED/KEPT no longer on the members table: ${stale.join(', ')}`).toEqual([]);
  });

  it('the SCRUBBED set covers the H1 high-risk additions', () => {
    // Regression pin: the columns the H1 finding called out must stay scrubbed.
    for (const col of [
      'blockedFromAutoReactivationReason',
      'blockedFromAutoReactivationSetByUserId',
      'riskScore',
      'riskScoreBand',
      'riskScoreFactors',
      'riskScoreLastComputedAt',
      'riskSnoozedUntil',
    ]) {
      expect(SCRUBBED.has(col), `${col} must be in the SCRUBBED set`).toBe(true);
    }
  });
});

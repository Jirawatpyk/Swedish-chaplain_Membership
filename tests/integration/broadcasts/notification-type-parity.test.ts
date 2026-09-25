/**
 * F7 anti-drift parity test (TYPES recommendation #3, 2026-05-01).
 *
 * Asserts that every F7 value in the `notification_type` Postgres enum
 * is also present in the `F7NotificationType` TypeScript union (and
 * vice versa). Without this guard, adding a new enum value via SQL
 * migration and forgetting to update `email-transactional-bridge.ts`
 * — or vice versa — silently breaks runtime template resolution.
 *
 * Migrated to the shared `assertEnumParity` helper in
 * `tests/integration/_helpers/assert-enum-parity.ts` (post-PR #19
 * refactor) so F4 / F5 / future features can replicate the pattern.
 */
import { describe, expect, it } from 'vitest';

import { F7_NOTIFICATION_TYPES } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { F119_NOTIFICATION_TYPES } from '@/modules/broadcasts/application/ports/eblast-notification-outbox-port';
import { getEnumParity } from '../helpers/assert-enum-parity';

describe('F7 notification_type ↔ F7NotificationType parity', () => {
  it('every F7 TS-union value exists in pg_enum, and every broadcast_*_notification pg_enum value is in the TS union', async () => {
    const result = await getEnumParity({
      typeName: 'notification_type',
      tsValues: F7_NOTIFICATION_TYPES,
      // Filter to F7-namespaced notification types only — F1+F4 events
      // (member_invitation, email_verification, invoice_auto_email,
      // receipt_pdf_render, …) live alongside in the same enum and are
      // intentionally out of scope for the F7 parity check.
      sqlScopeFilter: (label) =>
        label.startsWith('broadcast_') && label.endsWith('_notification'),
    });

    expect(
      { missingInSql: result.missingInSql, missingInTs: result.missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(result.missingInSql)}\n  TS union missing SQL values: ${JSON.stringify(result.missingInTs)}\n\nAdd a migration to extend notification_type, OR update F7_NOTIFICATION_TYPES in email-transactional-bridge.ts.`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

/**
 * #400 PR-B item 10 — the same guard for the five F119 approval-round types
 * (migration 0308). `F119_NOTIFICATION_TYPES` is what the outbox drainer skips
 * while FEATURE_EBLAST_MEMBER_APPROVAL is off and what the enqueue port may
 * write; a pg_enum value it lacks would be neither skipped nor typed, and one
 * it has that the enum lacks would fail every enqueue at INSERT.
 */
describe('F119 notification_type ↔ F119_NOTIFICATION_TYPES parity', () => {
  it('every F119 value exists in pg_enum, and every eblast_* pg_enum value is in the tuple', async () => {
    const result = await getEnumParity({
      typeName: 'notification_type',
      tsValues: F119_NOTIFICATION_TYPES,
      sqlScopeFilter: (label) => label.startsWith('eblast_'),
    });

    expect(result.sqlCount, 'positive control: the eblast_* scope of pg_enum is not empty').toBeGreaterThan(0);
    // `missingInTsDeclaredHere`, not `missingInTs`: on the shared dev branch a
    // sibling branch's applied migration is not this tree's drift (the helper's
    // own guidance).
    expect(
      { missingInSql: result.missingInSql, missingInTs: result.missingInTsDeclaredHere },
      `Drift detected:
  SQL missing TS values: ${JSON.stringify(result.missingInSql)}
  TS tuple missing SQL values: ${JSON.stringify(result.missingInTs)}

Add a migration to extend notification_type, OR update F119_NOTIFICATION_TYPES in eblast-notification-outbox-port.ts.`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

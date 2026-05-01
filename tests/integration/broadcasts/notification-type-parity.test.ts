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

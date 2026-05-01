/**
 * F7 anti-drift parity test #2 — `audit_event_type` ↔ `F7AuditEventType`.
 *
 * Mirrors `notification-type-parity.test.ts` pattern. Asserts that
 * every F7 audit event in the `audit_event_type` Postgres enum has a
 * matching entry in the `F7_AUDIT_EVENT_TYPES` TypeScript tuple (and
 * vice versa). Catches drift between F7 audit migrations and the
 * Application port at the integration layer.
 *
 * Migrated to the shared `assertEnumParity` helper in
 * `tests/integration/_helpers/assert-enum-parity.ts` (post-PR #19
 * refactor) so F4 / F5 / future features can replicate the pattern.
 *
 * Scope filter: `broadcast_*` prefix plus the two member-* events that
 * participate in F7 flows but live outside the prefix.
 */
import { describe, expect, it } from 'vitest';

import { F7_AUDIT_EVENT_TYPES } from '@/modules/broadcasts/application/ports/audit-port';
import { getEnumParity } from '../helpers/assert-enum-parity';

describe('F7 audit_event_type ↔ F7AuditEventType parity', () => {
  it('every F7 TS-tuple value exists in pg_enum, and every broadcast_* + F7-prefixed pg_enum value is in the TS tuple', async () => {
    const result = await getEnumParity({
      typeName: 'audit_event_type',
      tsValues: F7_AUDIT_EVENT_TYPES,
      sqlScopeFilter: (label) =>
        label.startsWith('broadcast_') ||
        label === 'member_acknowledged_broadcasts_terms' ||
        label === 'member_missing_primary_contact',
    });

    expect(
      { missingInSql: result.missingInSql, missingInTs: result.missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(result.missingInSql)}\n  TS tuple missing SQL values: ${JSON.stringify(result.missingInTs)}\n\nAdd a migration to extend audit_event_type, OR update F7_AUDIT_EVENT_TYPES in audit-port.ts (and bump _AssertF7AuditEventCount accordingly).`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

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

import {
  F7_AUDIT_EVENT_TYPES,
  RETIRED_F7_AUDIT_EVENT_TYPES,
} from '@/modules/broadcasts/application/ports/audit-port';
import { getEnumParity } from '../helpers/assert-enum-parity';

const RETIRED: ReadonlySet<string> = new Set(RETIRED_F7_AUDIT_EVENT_TYPES);

describe('F7 audit_event_type ↔ F7AuditEventType parity', () => {
  it('every F7 TS-tuple value exists in pg_enum, and every broadcast_* + F7-prefixed pg_enum value is in the TS tuple', async () => {
    const result = await getEnumParity({
      typeName: 'audit_event_type',
      tsValues: F7_AUDIT_EVENT_TYPES,
      // Retired values stay in pg_enum for ever (Postgres cannot drop one) and
      // are deliberately absent from the TS tuple, so they must leave the
      // SQL→TS direction's scope or this test reports drift the branch cannot
      // fix. Read from the shared const — never restate the six names here, or
      // the next retirement desyncs this file from the audit viewer again.
      sqlScopeFilter: (label) =>
        !RETIRED.has(label) &&
        (label.startsWith('broadcast_') ||
          label === 'member_acknowledged_broadcasts_terms' ||
          label === 'member_missing_primary_contact'),
    });

    // The SQL→TS direction is scoped to values a migration IN THIS TREE
    // declares — the CI/dev Neon branch is SHARED, so a sibling branch's
    // migration puts values there this branch cannot (and must not) add to the
    // tuple. Same rule as the F5 parity test; foreign values are warned about
    // by the helper and listed below for triage.
    expect(
      {
        missingInSql: result.missingInSql,
        missingInTs: result.missingInTsDeclaredHere,
      },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(result.missingInSql)}\n  TS tuple missing SQL values (declared by a migration in THIS tree): ${JSON.stringify(result.missingInTsDeclaredHere)}\n\nAdd a migration to extend audit_event_type, OR update F7_AUDIT_EVENT_TYPES in audit-port.ts (and bump _AssertF7AuditEventCount accordingly).\n\nIgnored as sibling-branch values (no declaring migration in this tree): ${JSON.stringify(result.missingInTsForeign)}`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

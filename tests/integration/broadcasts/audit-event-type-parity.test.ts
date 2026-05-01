/**
 * F7 anti-drift parity test #2 — `audit_event_type` ↔ `F7AuditEventType`.
 *
 * Mirrors `notification-type-parity.test.ts` pattern. Asserts that
 * every F7 audit event in the `audit_event_type` Postgres enum has a
 * matching entry in the `F7_AUDIT_EVENT_TYPES` TypeScript tuple (and
 * vice versa). Catches drift between F7 audit migrations and the
 * Application port at the integration layer.
 *
 * The filter uses `LIKE 'broadcast_%'` to scope the comparison to F7
 * audit events; F1+F2+F3+F4+F5 events live alongside in the same enum
 * and are intentionally excluded. Two F7 events outside the prefix
 * (`member_acknowledged_broadcasts_terms`, `member_missing_primary_contact`)
 * are added back via OR-clauses since they participate in F7 flows.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  F7_AUDIT_EVENT_TYPES,
  type F7AuditEventType,
} from '@/modules/broadcasts/application/ports/audit-port';

describe('F7 audit_event_type ↔ F7AuditEventType parity', () => {
  it('every F7 TS-tuple value exists in pg_enum, and every broadcast_* + F7-prefixed pg_enum value is in the TS tuple', async () => {
    const tsValues = new Set<F7AuditEventType>(F7_AUDIT_EVENT_TYPES);

    // SQL side: enumerate every F7-relevant enum label. Use the same
    // shape filter as the TS tuple — broadcast_* prefix plus the two
    // member_* events that participate in F7 flows.
    const rows = (await db.execute(sql`
      SELECT enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'audit_event_type'
        AND (
          enumlabel LIKE 'broadcast\\_%' ESCAPE '\\'
          OR enumlabel = 'member_acknowledged_broadcasts_terms'
          OR enumlabel = 'member_missing_primary_contact'
        )
      ORDER BY enumsortorder
    `)) as unknown as Array<{ label: string }>;

    const sqlValues = new Set(rows.map((r) => r.label));

    const missingInSql: string[] = [];
    for (const tsv of tsValues) {
      if (!sqlValues.has(tsv)) missingInSql.push(tsv);
    }

    const missingInTs: string[] = [];
    for (const sv of sqlValues) {
      if (!tsValues.has(sv as F7AuditEventType)) missingInTs.push(sv);
    }

    expect(
      { missingInSql, missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(missingInSql)}\n  TS tuple missing SQL values: ${JSON.stringify(missingInTs)}\n\nAdd a migration to extend audit_event_type, OR update F7_AUDIT_EVENT_TYPES in audit-port.ts (and bump _AssertF7AuditEventCount accordingly).`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

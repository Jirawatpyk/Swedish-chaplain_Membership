/**
 * F7 anti-drift parity test (TYPES recommendation #3, 2026-05-01).
 *
 * Asserts that every F7 value in the `notification_type` Postgres enum
 * is also present in the `F7NotificationType` TypeScript union (and
 * vice versa). Without this guard, adding a new enum value via SQL
 * migration and forgetting to update `email-transactional-bridge.ts`
 * — or vice versa — silently breaks runtime template resolution.
 *
 * Drift modes covered:
 *   1. SQL value missing from TS union  → `resolveNotificationType` would
 *      throw at runtime when an outbox row for the missing key is
 *      enqueued (or fall through dispatcher fallback)
 *   2. TS union value missing from SQL  → enqueueOutboxRow would throw
 *      `invalid input value for enum notification_type` on insert
 *
 * Lives in integration/ because `pg_enum` is only readable via a real
 * DB connection — the unit-test layer has no Postgres handle.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  F7_NOTIFICATION_TYPES,
  type F7NotificationType,
} from '@/modules/broadcasts/infrastructure/email-transactional-bridge';

describe('F7 notification_type ↔ F7NotificationType parity', () => {
  it('every F7 TS-union value exists in pg_enum, and every broadcast_*_notification pg_enum value is in the TS union', async () => {
    const rows = (await db.execute(sql`
      SELECT enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'notification_type'
        AND enumlabel LIKE 'broadcast\\_%\\_notification' ESCAPE '\\'
      ORDER BY enumsortorder
    `)) as unknown as Array<{ label: string }>;

    const sqlValues = new Set(rows.map((r) => r.label));
    const tsValues = new Set<F7NotificationType>(F7_NOTIFICATION_TYPES);

    // 1. Every TS-union value MUST exist in the Postgres enum.
    const missingInSql: string[] = [];
    for (const tsv of tsValues) {
      if (!sqlValues.has(tsv)) missingInSql.push(tsv);
    }

    // 2. Every `broadcast_*_notification` enum value MUST exist in the
    //    TS union (the LIKE filter restricts the comparison to the F7
    //    namespace; F1+F4 outbox notification types live alongside in
    //    the same enum and are intentionally excluded).
    const missingInTs: string[] = [];
    for (const sv of sqlValues) {
      if (!tsValues.has(sv as F7NotificationType)) missingInTs.push(sv);
    }

    expect(
      { missingInSql, missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(missingInSql)}\n  TS union missing SQL values: ${JSON.stringify(missingInTs)}\n\nAdd a migration to extend notification_type, OR update F7_NOTIFICATION_TYPES in email-transactional-bridge.ts.`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});

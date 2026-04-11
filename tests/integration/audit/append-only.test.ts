/**
 * T026 — append-only enforcement on `audit_log` (security.md T-13).
 *
 * Verifies the BEFORE UPDATE / BEFORE DELETE / BEFORE TRUNCATE triggers
 * created in `drizzle/migrations/0001_audit_log_append_only.sql` actually
 * fire and block any modification attempt — defense in depth on top of
 * the application-layer audit-repo `append()`-only API (T067).
 *
 * Skipped automatically when DATABASE_URL is not set (see
 * tests/integration-setup.ts which throws at suite-load if missing).
 *
 * NOTE: This test inserts rows that cannot be deleted (the triggers block
 * DELETE too). Run against a dedicated Neon **test branch**, not the
 * production database. The CI workflow creates a fresh branch per run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';

const TEST_REQUEST_ID = `append-only-test-${Date.now()}`;

describe('audit_log append-only enforcement', () => {
  it('rejects UPDATE on audit_log with permission-denied SQLSTATE', async () => {
    const inserted = await db
      .insert(auditLog)
      .values({
        eventType: 'sign_in_success',
        actorUserId: 'system:test',
        summary: 'append-only update test',
        requestId: TEST_REQUEST_ID,
      })
      .returning();

    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;

    await expect(
      db.update(auditLog).set({ summary: 'tampered' }).where(eq(auditLog.id, row.id)),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE on audit_log', async () => {
    const inserted = await db
      .insert(auditLog)
      .values({
        eventType: 'sign_out',
        actorUserId: 'system:test',
        summary: 'append-only delete test',
        requestId: TEST_REQUEST_ID,
      })
      .returning();

    const row = inserted[0]!;

    await expect(
      db.delete(auditLog).where(eq(auditLog.id, row.id)),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects TRUNCATE on audit_log via raw SQL', async () => {
    await expect(db.execute('TRUNCATE TABLE audit_log')).rejects.toThrow(
      /append-only/i,
    );
  });

  it('still permits INSERT (proves the table is not fully locked)', async () => {
    const inserted = await db
      .insert(auditLog)
      .values({
        eventType: 'sign_in_success',
        actorUserId: 'system:test',
        summary: 'append-only insert still allowed',
        requestId: TEST_REQUEST_ID,
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.eventType).toBe('sign_in_success');
  });

  afterAll(() => {
    // Intentionally NO cleanup — DELETE is forbidden by design. Run this
    // suite against a disposable Neon branch.
  });
});

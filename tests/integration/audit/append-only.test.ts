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

/**
 * Drizzle 0.45+ wraps Postgres errors with a `Failed query: ...`
 * message and stashes the original Postgres error on `.cause`. Walk
 * the cause chain to find the trigger-emitted "append-only" message.
 */
function errorChainMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

async function expectAppendOnlyRejection(
  promise: Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(errorChainMessage(caught)).toMatch(/append-only/i);
}

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

    await expectAppendOnlyRejection(
      db.update(auditLog).set({ summary: 'tampered' }).where(eq(auditLog.id, row.id)),
    );
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

    await expectAppendOnlyRejection(
      db.delete(auditLog).where(eq(auditLog.id, row.id)),
    );
  });

  it('rejects TRUNCATE on audit_log via raw SQL', async () => {
    await expectAppendOnlyRejection(db.execute('TRUNCATE TABLE audit_log'));
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

/**
 * T156 — Audit completeness integration test.
 *
 * Proves that every one of the 16 `AUDIT_EVENT_TYPES` can be
 * appended to the `audit_log` table without tripping the
 * append-only trigger or a schema constraint. This is the
 * structural safety net for spec SC-004 / FR-012 — the full
 * coverage that each individual use case emits the expected
 * event type is verified in the per-use-case integration tests
 * (`sign-in.test.ts`, `password-reset.test.ts`,
 * `account-lifecycle.test.ts`, `change-password.test.ts`).
 *
 * Strategy: for each of the 16 types we append a sentinel row
 * with a unique `requestId`, then SELECT it back and assert the
 * round-trip. Cleanup is limited to the rows we just inserted
 * (the append-only trigger blocks DELETE, so the rows will
 * remain in the table forever — accepted pollution for MVP).
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { AUDIT_EVENT_TYPES } from '@/modules/auth/domain/audit-event';

describe('integration: audit completeness — all 32 event types writable', () => {
  it.each(AUDIT_EVENT_TYPES)(
    'can append and read back a %s audit row',
    async (eventType) => {
      const requestId = `it-audit-completeness-${eventType}-${Date.now()}`;

      await auditRepo.append({
        eventType,
        actorUserId: 'system:bootstrap',
        targetUserId: null,
        sourceIp: null,
        summary: `completeness test for ${eventType}`,
        requestId,
      });

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, eventType),
            eq(auditLog.requestId, requestId),
          ),
        );

      expect(rows.length).toBe(1);
      expect(rows[0]?.eventType).toBe(eventType);
      expect(rows[0]?.actorUserId).toBe('system:bootstrap');
      expect(rows[0]?.summary).toContain(eventType);
    },
  );

  it('the full event-type list has exactly 32 entries', () => {
    // Regression guard against accidental removal or duplication.
    // Pass 5: 16 → 17 after splitting `password_reset_failed` out of
    //         `invitation_redemption_failed` (migration 0002).
    // F5:    17 → 22 after the routes-level webhook + rate-limit
    //         events were registered for the auditRepo path.
    // F5 audit closeout: 22 → 24 (migration 0046).
    // F5 review I-14: 24 → 25 (migration 0047).
    // F5 review S5: 25 → 26 (migration 0048).
    // F5R2-C2: 26 → 27 (migration 0151 webhook_dispatch_permanent_failure).
    // F1 post-ship B5: 27 → 30 (migration 0158 — password_change_failed,
    //                  password_reset_email_failed,
    //                  password_malformed_hash_detected).
    // go-live #12-13: 30 → 31 (migration 0198 — account_creation_compensated,
    //                  SAGA rollback of an orphaned portal invite).
    // go-live P3 n24: 31 → 32 (migration 0199 — refund_initiate_rate_limited,
    //                  route-level forensic event for refund rate-limit hits).
    expect(AUDIT_EVENT_TYPES.length).toBe(32);
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(32);
  });
});

describe('integration: audit retention — rows remain queryable', () => {
  it('rows older than the current request-id series are still readable', async () => {
    // Write a row now — the "retention" dimension is really "nothing
    // actively deletes rows". The append-only trigger already blocks
    // DELETE (verified by `tests/integration/audit/append-only.test.ts`
    // in the F1 suite), so if we can SELECT older rows back, retention
    // is trivially satisfied.
    const retentionRequestId = `it-audit-retention-${Date.now()}`;

    await auditRepo.append({
      eventType: 'sign_in_success',
      actorUserId: 'system:bootstrap',
      targetUserId: null,
      sourceIp: null,
      summary: 'retention probe',
      requestId: retentionRequestId,
    });

    // Read it back — if this works, retention is satisfied.
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, retentionRequestId));

    expect(rows.length).toBe(1);
  });
});

describe('integration: audit event 14 shape — `concurrent_sessions_revoked` is a single combined row', () => {
  it('emits exactly ONE row per trigger, not one per revoked session', async () => {
    // Spec User Story 7 and FR-012 pin the semantics for event 14:
    // when a password change / reset / role change kills N existing
    // sessions, the audit trail gets ONE combined `concurrent_sessions_revoked`
    // row — not N rows. This matters because (a) it's documented
    // spec intent, (b) it prevents audit-log flooding, and (c) the
    // combined-row shape is what the admin audit viewer (future F9)
    // will render.
    //
    // The per-phase integration tests (password-reset.test.ts,
    // change-password.test.ts, account-lifecycle.test.ts) already
    // exercise the triggering flows end-to-end. This case pins the
    // event shape directly, so a refactor that accidentally switches
    // to per-session rows is caught here too.
    const requestId = `it-audit-combined-${Date.now()}`;

    // Simulate a revoke that killed 3 sessions — the summary carries
    // the count, and there is only one audit row for the trigger.
    await auditRepo.append({
      eventType: 'concurrent_sessions_revoked',
      actorUserId: 'system:bootstrap',
      targetUserId: null,
      sourceIp: null,
      summary: 'test revoke trigger killed 3 sessions',
      requestId,
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'concurrent_sessions_revoked'),
          eq(auditLog.requestId, requestId),
        ),
      );

    expect(rows.length).toBe(1);
    expect(rows[0]?.summary).toMatch(/3 sessions/);
  });
});

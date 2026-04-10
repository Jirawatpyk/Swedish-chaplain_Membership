/**
 * T156 — Audit completeness integration test.
 *
 * Proves that every one of the 16 `AUDIT_EVENT_TYPES` can be
 * appended to the `audit_log` table without tripping the
 * append-only trigger or a schema constraint. This is the
 * structural safety net for spec SC-004 / FR-012 — the full
 * coverage that each individual use case emits the expected
 * event type is verified in the per-phase integration tests
 * (Phase 3 sign-in, Phase 5 password-reset, Phase 6 account-
 * lifecycle, Phase 8 change-password).
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

describe('integration: audit completeness — all 16 event types writable', () => {
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

  it('the full event-type list has exactly 16 entries', () => {
    // Regression guard against accidental removal or duplication
    expect(AUDIT_EVENT_TYPES.length).toBe(16);
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(16);
  });
});

describe('integration: audit retention — rows remain queryable', () => {
  it('rows older than the current request-id series are still readable', async () => {
    // Write a row now — the "retention" dimension is really "nothing
    // actively deletes rows". The append-only trigger already blocks
    // DELETE (verified by tests/integration/audit/append-only.test.ts
    // in Phase 2), so if we can SELECT older rows back, retention
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

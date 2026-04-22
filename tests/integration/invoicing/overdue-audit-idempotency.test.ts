/**
 * T109 integration test — `invoice_overdue_detected` idempotency.
 *
 * Verifies the live-Neon contract of migration 0021's partial unique
 * index `audit_log_overdue_once_per_day`:
 *
 *   Two consecutive calls to `overdueAuditAdapter.emitOverdueOnce`
 *   for the SAME (tenant, invoice) on the SAME Bangkok-local day MUST
 *   produce exactly ONE audit row — the second call returns false
 *   (duplicate swallowed) without throwing.
 *
 * Complements the unit tests in `tests/unit/invoicing/derive-overdue.test.ts`
 * which cover the pure-derivation branches. The idempotency property
 * is a DB contract (partial unique index + ON CONFLICT DO NOTHING),
 * so the only meaningful coverage is end-to-end on Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import '@js-joda/timezone';
import { LocalDate, ZoneId } from '@js-joda/core';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { overdueAuditAdapter } from '@/modules/invoicing/infrastructure/adapters/overdue-audit-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('T109 — overdue audit emit idempotency (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('second emit for the same (tenant, invoice, day) returns false and writes no row', async () => {
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    // Asia/Bangkok wall-clock date — matches the key the production
    // allocator + partial unique index use. A UTC slice would drift
    // during UTC 17:00–23:59 (Bangkok next day) and make this test
    // flaky for a 7-hour window each day.
    const todayBkk = LocalDate.now(ZoneId.of('Asia/Bangkok')).toString();

    // First emit — expect true (new row).
    const first = await overdueAuditAdapter.emitOverdueOnce({
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 't109-req-1',
      invoiceId,
      memberId,
      documentNumber: 'INV-2026-T109',
      dueDate: '2026-04-01',
      bangkokLocalDate: todayBkk,
    });
    expect(first).toBe(true);

    // Second emit — same tenant+invoice+day → duplicate swallowed.
    const second = await overdueAuditAdapter.emitOverdueOnce({
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 't109-req-2',
      invoiceId,
      memberId,
      documentNumber: 'INV-2026-T109',
      dueDate: '2026-04-01',
      bangkokLocalDate: todayBkk,
    });
    expect(second).toBe(false);

    // Exactly one audit row exists for this invoice.
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_overdue_detected'),
        ),
      );
    const matching = rows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === invoiceId,
    );
    expect(matching).toHaveLength(1);
    // The landed row must be from the FIRST call (requestId 1) —
    // the index guarantees at-most-once, so no overwrite occurred.
    expect(matching[0]!.requestId).toBe('t109-req-1');
    const payload = matching[0]!.payload as Record<string, unknown>;
    expect(payload.member_id).toBe(memberId);
    expect(payload.due_date).toBe('2026-04-01');
    expect(payload.detected_bangkok_date).toBe(todayBkk);
  }, 30_000);

  it('different invoices on the same day both emit (scoping is per-invoice)', async () => {
    const invoiceA = randomUUID();
    const invoiceB = randomUUID();
    // Bangkok wall-clock date, matching the partial-unique-index key.
    // A UTC slice drifts during UTC 17:00–23:59 (Bangkok next day) —
    // same rationale as the first test above.
    const todayBkk = LocalDate.now(ZoneId.of('Asia/Bangkok')).toString();

    const a = await overdueAuditAdapter.emitOverdueOnce({
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 't109-scope-a',
      invoiceId: invoiceA,
      memberId: 'm-a',
      documentNumber: 'INV-A',
      dueDate: '2026-04-01',
      bangkokLocalDate: todayBkk,
    });
    const b = await overdueAuditAdapter.emitOverdueOnce({
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 't109-scope-b',
      invoiceId: invoiceB,
      memberId: 'm-b',
      documentNumber: 'INV-B',
      dueDate: '2026-04-01',
      bangkokLocalDate: todayBkk,
    });
    expect(a).toBe(true);
    expect(b).toBe(true);
  }, 30_000);
});

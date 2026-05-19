/**
 * R7 round-2 follow-up — `payment_method_switched` audit row persistence.
 *
 * Pins the integration contract that the F4/F5 audit adapter
 * (`f5AuditAdapter`) writes a `payment_method_switched` row to
 * `audit_log` with the exact payload shape documented in
 * `initiate-payment.ts` (previous_method / new_method /
 * processor_payment_intent_id / attempt_seq / cancel_outcome). Closes
 * the #9 gap from the speckit-review pass: unit tests already cover
 * the use-case branches with a mock audit port, but no integration
 * test asserted the row actually lands on live Neon.
 *
 * We exercise the adapter directly (not the full `initiatePayment`
 * use-case) because the use-case path goes through
 * `tenantSettingsRepo.getByTenantId`, which is wrapped in
 * `unstable_cache`, which requires Next.js request context — outside
 * the integration suite's runtime. The adapter-level test is
 * sufficient for the contract this finding asked for: schema +
 * payload + retention + tenant scoping.
 *
 * Mocking policy: live Postgres only. No mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { retentionFor } from '@/modules/payments/application/ports/audit-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('f5AuditAdapter — payment_method_switched persistence', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  it('persists a payment_method_switched row with the documented payload shape under runInTenant', async () => {
    const piId = `pi_test_pms_audit_${Date.now()}`;
    const requestId = `test-req-${Date.now()}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await f5AuditAdapter.emit(tx, {
        tenantId: tenant.ctx.slug,
        requestId,
        eventType: 'payment_method_switched',
        actorUserId: user.userId,
        summary: 'Payment pmt_test_audit method switched from card to promptpay',
        payload: {
          payment_id: 'pmt_test_audit',
          previous_method: 'card',
          new_method: 'promptpay',
          processor_payment_intent_id: piId,
          attempt_seq: 1,
          cancel_outcome: 'stripe_confirmed',
        },
        retentionYears: retentionFor('payment_method_switched'),
      });
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'payment_method_switched'),
          eq(auditLog.requestId, requestId),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actorUserId).toBe(user.userId);
    expect(row.tenantId).toBe(tenant.ctx.slug);
    expect(row.summary).toContain('method switched from card to promptpay');

    const payload = row.payload as {
      readonly payment_id?: string;
      readonly previous_method?: string;
      readonly new_method?: string;
      readonly processor_payment_intent_id?: string;
      readonly attempt_seq?: number;
      readonly cancel_outcome?: string;
    } | null;
    expect(payload).not.toBeNull();
    expect(payload!.payment_id).toBe('pmt_test_audit');
    expect(payload!.previous_method).toBe('card');
    expect(payload!.new_method).toBe('promptpay');
    expect(payload!.processor_payment_intent_id).toBe(piId);
    expect(payload!.attempt_seq).toBe(1);
    expect(payload!.cancel_outcome).toBe('stripe_confirmed');
  });

  it('payload accepts the alternative cancel_outcome=`stripe_error_bypassed` discriminator', async () => {
    const requestId = `test-req-bypass-${Date.now()}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await f5AuditAdapter.emit(tx, {
        tenantId: tenant.ctx.slug,
        requestId,
        eventType: 'payment_method_switched',
        actorUserId: user.userId,
        summary:
          'Payment pmt_bypass method switched from promptpay to card (stripe error bypassed)',
        payload: {
          payment_id: 'pmt_bypass',
          previous_method: 'promptpay',
          new_method: 'card',
          processor_payment_intent_id: 'pi_test_already_canceled',
          attempt_seq: 2,
          cancel_outcome: 'stripe_error_bypassed',
        },
        retentionYears: retentionFor('payment_method_switched'),
      });
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'payment_method_switched'),
          eq(auditLog.requestId, requestId),
        ),
      )
      .limit(1);

    expect(rows.length).toBe(1);
    const payload = rows[0]!.payload as {
      readonly cancel_outcome?: string;
    } | null;
    expect(payload?.cancel_outcome).toBe('stripe_error_bypassed');
  });

  it('retention map returns 5 years for payment_method_switched (F5R1-IMP7 corrected baseline)', () => {
    // F5R1-IMP7 (review-20260427) corrected the retention class from
    // 10y → 5y. Reasoning: `payment_method_switched` records an
    // operational event (user chose card → switched to PromptPay
    // mid-flow). It does NOT touch tax-document settlement state
    // (the underlying `payment_succeeded` audit is the
    // tax-document touch and carries its own 10y retention). Thus
    // operational class per Constitution VIII §86/3 → 5y is the
    // correct minimum. The original 10y was an over-classification
    // caught by the R1 retention review.
    expect(retentionFor('payment_method_switched')).toBe(5);
  });

  it('cross-tenant: tenant B SELECT under runInTenant cannot see tenant A audit rows (R3-fix IG-4)', async () => {
    // R3-fix IG-4 (2026-04-26): Constitution v1.4.0 Principle I clause 3
    // requires every feature touching tenant-scoped data to include a
    // cross-tenant integration test. This file already exercises
    // single-tenant persistence; this `it` block adversarially probes
    // tenant B against the previously-seeded tenant A row to prove
    // RLS enforcement on the audit_log read path under
    // `runInTenant(B, …)`.
    const tenantB = await createTestTenant('test-chamber');
    try {
      // The first `it` above seeded a payment_method_switched row in
      // tenant A's audit_log. Tenant B reading the same eventType must
      // see ZERO rows for tenant A (and zero rows of its own — none seeded).
      const rowsFromB = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenant.ctx.slug),
              eq(auditLog.eventType, 'payment_method_switched'),
            ),
          ),
      );
      expect(rowsFromB.length).toBe(0);
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });
});

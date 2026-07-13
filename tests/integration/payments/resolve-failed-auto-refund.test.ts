/**
 * CF-2 integration — `resolveFailedAutoRefund` end-to-end against live Neon.
 *
 * Exercises the REAL composition (`makeResolveFailedAutoRefundDeps` → drizzle
 * payments repo + F5 audit adapter) so the `auto_refund_reconciled` enum value
 * (migration 0244), the tenant-scoped emit inside `withTx`, and the correlated
 * `findStaleInvoiceAutoRefund.failed` read are all validated against real
 * Postgres — the enum + JSON-payload EXISTS semantics that unit mocks hide.
 *
 * Scenario: an admin marks a permanently-failed stale-invoice auto-refund as
 * manually reconciled. Asserts the emit lands, `failed` flips false (admin alert
 * clears + member banner reverts), the action is idempotent (no second row), and
 * it refuses when no failure forensic exists.
 *
 * Mocking policy: hits live Postgres. No SUT mocks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import {
  resolveFailedAutoRefund,
  makeResolveFailedAutoRefundDeps,
} from '@/modules/payments';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('resolveFailedAutoRefund — live Neon (CF-2)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
  });

  // Seed the realistic pair a stale-invoice auto-refund failure leaves behind:
  // the initiation marker (`payment_auto_refunded_stale_invoice`, which
  // `findStaleInvoiceAutoRefund` keys its non-null return on) + the CRITICAL-2
  // failure forensic (`auto_refund_failed_needs_manual_reconcile`).
  async function seedFailureForensic(
    invoiceId: string,
    paymentId: string,
    refundId: string,
  ): Promise<void> {
    const initPayload = JSON.stringify({
      payment_id: paymentId,
      invoice_id: invoiceId,
      refunded_amount_satang: '1000000',
      cause: 'invoice_voided',
      processor_refund_id: refundId,
    });
    const failPayload = JSON.stringify({
      payment_id: paymentId,
      invoice_id: invoiceId,
      auto_refund_processor_refund_id: refundId,
      refund_status: 'failed',
      amount_satang: '1000000',
      runbook_url: 'docs/runbooks/out-of-band-refund.md',
    });
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_log
          (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
        VALUES
          ('payment_auto_refunded_stale_invoice'::audit_event_type,
           '00000000-0000-0000-0000-000000000000', 'cf2 int init',
           ${`cf2-int-init-${invoiceId}`}, ${initPayload}::jsonb,
           ${tenantA.ctx.slug}, 10),
          ('auto_refund_failed_needs_manual_reconcile'::audit_event_type,
           '00000000-0000-0000-0000-000000000000', 'cf2 int fail',
           ${`cf2-int-fail-${invoiceId}`}, ${failPayload}::jsonb,
           ${tenantA.ctx.slug}, 10)
      `);
    });
  }

  async function countReconcileRows(invoiceId: string): Promise<number> {
    return runInTenant(tenantA.ctx, async (tx) => {
      const r = await tx.execute(sql`
        SELECT count(*)::int AS n
          FROM audit_log
         WHERE tenant_id = ${tenantA.ctx.slug}
           AND event_type = 'auto_refund_reconciled'
           AND payload->>'invoice_id' = ${invoiceId}
      `);
      return Number(Array.from(r as unknown as Iterable<{ n: number }>)[0]!.n);
    });
  }

  it('emits auto_refund_reconciled, flips failed→false, is idempotent, refuses when no failure exists', async () => {
    const invoiceId = randomUUID();
    const paymentId = `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const refundId = `re_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedFailureForensic(invoiceId, paymentId, refundId);

    const repo = makeDrizzlePaymentsRepo(tenantA.ctx.slug);
    expect((await repo.findStaleInvoiceAutoRefund(invoiceId))?.failed).toBe(true);

    const deps = makeResolveFailedAutoRefundDeps(tenantA.ctx.slug);

    // (1) Reconcile — emits the real audit row with the acting admin + a note.
    const r1 = await resolveFailedAutoRefund(deps, {
      tenantId: tenantA.ctx.slug,
      invoiceId,
      actorUserId: admin.userId,
      requestId: 'cf2-int-1',
      note: 'Refunded manually via Stripe Dashboard',
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.kind).toBe('reconciled');
    expect(await countReconcileRows(invoiceId)).toBe(1);

    // failed flips false → admin alert clears + member banner reverts. The
    // initiation marker still exists → non-null return keeps the member
    // "refunded" copy path (processorRefundId still surfaced).
    const afterReconcile = await repo.findStaleInvoiceAutoRefund(invoiceId);
    expect(afterReconcile?.failed).toBe(false);
    expect(afterReconcile?.processorRefundId).toBe(refundId);

    // (2) Idempotent — a second call is a benign no-op; NO second row.
    const r2 = await resolveFailedAutoRefund(deps, {
      tenantId: tenantA.ctx.slug,
      invoiceId,
      actorUserId: admin.userId,
      requestId: 'cf2-int-2',
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.kind).toBe('already_reconciled');
    expect(await countReconcileRows(invoiceId)).toBe(1);

    // (3) Refuses when NO failure forensic exists for the invoice.
    const r3 = await resolveFailedAutoRefund(deps, {
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(),
      actorUserId: admin.userId,
      requestId: 'cf2-int-3',
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('no_failed_auto_refund');
  });

  it('S1: cross-tenant — tenant B deps against tenant A invoice refuse (no_failed_auto_refund)', async () => {
    // Constitution Principle I clause 3 — DIRECT cross-tenant negative for the
    // CF-2 use-case (not just the sibling repo read). Seed a REAL failed-auto-
    // refund forensic under tenant A, then drive `resolveFailedAutoRefund` with
    // tenant B's deps + tenant B's tenantId against tenant A's invoiceId. The
    // forensic read runs under tenant B's RLS context + tenant_id filter, so
    // tenant A's row is invisible → the use-case refuses (never emitting a
    // reconcile for another tenant's invoice). If isolation were broken, this
    // would return `reconciled` carrying tenant A's ids.
    const invoiceId = randomUUID();
    const paymentId = `pmt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const refundId = `re_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await seedFailureForensic(invoiceId, paymentId, refundId); // seeds under tenant A

    const depsB = makeResolveFailedAutoRefundDeps(tenantB.ctx.slug);
    const rB = await resolveFailedAutoRefund(depsB, {
      tenantId: tenantB.ctx.slug,
      invoiceId, // tenant A's invoice id, probed from tenant B
      actorUserId: admin.userId,
      requestId: 's1-cross-tenant',
    });
    expect(rB.ok).toBe(false);
    if (!rB.ok) expect(rB.error.code).toBe('no_failed_auto_refund');

    // And tenant B's refused call left NO reconcile row on tenant A's invoice.
    expect(await countReconcileRows(invoiceId)).toBe(0);
  });
});

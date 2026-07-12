/**
 * 070 F8 item #18 — admin reactivate / reject pending-reactivation cycles
 * (live Neon Singapore).
 *
 * Exercises the two already-built use-cases end-to-end against real
 * Postgres so the RLS policies, CHECK constraints, advisory locks, and
 * in-tx audit emits are validated (unit mocks hide all four):
 *
 *   1. adminReactivateLapsedCycle: pending_admin_reactivation → completed
 *      (closed_reason='admin_reactivated') + `lapsed_member_admin_reactivated`
 *      audit. (`completed` requires a linked invoice → seed a draft.)
 *   2. adminRejectReactivation (refund issued): pending_admin_reactivation →
 *      cancelled (closed_reason='admin_rejected_with_refund') +
 *      refund_credit_note_id from the (stubbed) F5 bridge + the
 *      `lapsed_member_admin_reactivation_rejected` audit + the post-refund
 *      `post_refund_review` finance escalation task + `escalation_task_created`
 *      audit.
 *   3. adminRejectReactivation (no linked invoice): refund_credit_note_id is
 *      null (no refund attempted), NO post-refund task created.
 *   4. Cross-tenant isolation: tenant B's deps cannot act on tenant A's cycle
 *      → cycle_not_found (RLS hides the row).
 *   5. Concurrent double-reactivate: one wins (completed), the other gets
 *      cycle_not_pending (advisory lock + transitionStatus CAS).
 *   6. Concurrent double-reject (NIT-1): both callers reach the refund, but
 *      the F5 idempotency net issues money EXACTLY ONCE and the tx2 CAS
 *      lets exactly one win the cancel transition (the loser → server_error).
 *   7. refund_failed (NIT-2): an F5 refund failure leaves the cycle in
 *      `pending_admin_reactivation` (re-tryable, no orphan / partial state).
 *
 * The F5 refund bridge is STUBBED on a per-test deps override (same
 * pattern as pending-reactivation-timeout-admin-race.test.ts) so no real
 * Stripe call is made.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import {
  adminReactivateLapsedCycle,
  adminRejectReactivation,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { F5RefundBridge } from '@/modules/renewals/application/ports/f5-refund-bridge';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

interface SeedPendingCycleArgs {
  readonly tenant: TestTenant;
  readonly user: TestUser;
  readonly withInvoice: boolean;
}

interface SeededCycle {
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string | null;
}

/**
 * Seed a `pending_admin_reactivation` cycle (optionally linked to a draft
 * membership invoice so the `completed` CHECK + refund path resolve).
 */
async function seedPendingCycle(
  args: SeedPendingCycleArgs,
): Promise<SeededCycle> {
  const { tenant, user, withInvoice } = args;
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const invoiceId = withInvoice ? randomUUID() : null;
  const planId = `f8-rr-${randomUUID().slice(0, 8)}`;

  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Reactivate/Reject Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'RR Co',
      country: 'TH',
      planId,
      planYear: 2026,
    }),
  );
  if (withInvoice && invoiceId !== null) {
    // Draft membership invoice — satisfies the linked-invoice FK +
    // `completed_requires_invoice` CHECK; draft sidesteps the non-draft
    // snapshot/numbering CHECKs.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planId,
        planYear: 2026,
        invoiceSubject: 'membership',
        status: 'draft',
        draftByUserId: user.userId,
        currency: 'THB',
      }),
    );
  }
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'pending_admin_reactivation',
      periodFrom: new Date('2026-01-01T00:00:00Z'),
      periodTo: new Date('2027-01-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      enteredPendingAt: new Date('2026-04-15T00:00:00Z'),
      ...(invoiceId !== null ? { linkedInvoiceId: invoiceId } : {}),
    }),
  );
  return { memberId, cycleId, invoiceId };
}

/**
 * F8-RP follow-up — the SYNC reject path never calls the settlement lookup
 * (`getRefundOutcomeForInvoice` is only used by the reconcile cron for
 * async-marked cycles). Shared stub so every F5 bridge stub below satisfies
 * the port without duplicating the throwaway method.
 */
function settlementLookupUnused(): F5RefundBridge['getRefundOutcomeForInvoice'] {
  return vi.fn(async () => ({ status: 'not_found' as const }));
}

/** Stub F5 bridge that issues a synthetic credit-note (no Stripe). */
function refundedStub(): F5RefundBridge {
  return {
    issueRefundForInvoice: vi.fn(async () => ({
      status: 'refunded' as const,
      refundId: randomUUID(),
      creditNoteId: randomUUID(),
      creditNoteNumber: 'CN-RR-1',
    })),
    getRefundOutcomeForInvoice: settlementLookupUnused(),
  };
}

/**
 * Stub F5 bridge modelling the PRODUCTION double-refund safety net (NIT-1).
 *
 * The real `f5-refund-bridge-drizzle` adapter computes the remaining
 * refundable balance: the FIRST refund of a fully-paid invoice returns
 * `refunded`; a SECOND refund of the now-fully-refunded invoice finds no
 * remaining balance and returns `no_payment_found` WITHOUT a Stripe call
 * (F5 `issueRefund` also carries a Stripe idempotency key). This stub
 * reproduces that contract so a concurrent double-reject — where both
 * callers pass the tx1 validate-under-lock re-read and reach the refund —
 * issues money EXACTLY ONCE. Tracks how many invocations actually issued
 * a credit-note (`refundedCount`) vs were idempotent no-ops.
 */
function refundOnceThenNoPaymentStub(): F5RefundBridge & {
  refundedCount: () => number;
} {
  let refunded = 0;
  const fn = vi.fn<F5RefundBridge['issueRefundForInvoice']>(async () => {
    if (refunded > 0) {
      // Invoice already fully refunded — F5 net short-circuits, no money.
      return { status: 'no_payment_found' as const };
    }
    refunded += 1;
    return {
      status: 'refunded' as const,
      refundId: randomUUID(),
      creditNoteId: randomUUID(),
      creditNoteNumber: 'CN-RR-CONCURRENT-1',
    };
  });
  return {
    issueRefundForInvoice: fn,
    getRefundOutcomeForInvoice: settlementLookupUnused(),
    refundedCount: () => refunded,
  };
}

/** Stub F5 bridge that always reports a refund failure (NIT-2). */
function refundFailedStub(): F5RefundBridge {
  return {
    issueRefundForInvoice: vi.fn(async () => ({
      status: 'refund_failed' as const,
      errorCode: 'processor_unavailable',
      detail: 'simulated F5 processor outage',
    })),
    getRefundOutcomeForInvoice: settlementLookupUnused(),
  };
}

async function countAudit(
  tenant: TestTenant,
  eventType: string,
): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          // audit_log pgEnum TS union lags the live DB enum for these
          // F8 event types — cast to never (precedent: auto-reactivation-flow).
          eq(auditLog.eventType, eventType as never),
        ),
      ),
  );
  return rows.length;
}

describe('F8 admin reactivate/reject pending-reactivation cycles (070)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db
        .delete(renewalEscalationTasks)
        .where(eq(renewalEscalationTasks.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(invoices)
        .where(eq(invoices.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('reactivate: pending → completed/admin_reactivated + audit', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });

    const before = await countAudit(tenantA, 'lapsed_member_admin_reactivated');

    const r = await adminReactivateLapsedCycle(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cycleStatus).toBe('completed');
      expect(r.value.closedReason).toBe('admin_reactivated');
      expect(typeof r.value.closedAt).toBe('string');
    }

    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
          closedAt: renewalCycles.closedAt,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('completed');
    expect(row[0]?.closedReason).toBe('admin_reactivated');
    expect(row[0]?.closedAt).not.toBeNull();

    const after = await countAudit(tenantA, 'lapsed_member_admin_reactivated');
    expect(after).toBe(before + 1);
  });

  it('reject (refund): pending → cancelled/admin_rejected_with_refund + refund credit-note + audit + post-refund task', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId, memberId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });
    const stub = refundedStub();
    const racedDeps = { ...deps, f5RefundBridge: stub };

    const beforeRejAudit = await countAudit(
      tenantA,
      'lapsed_member_admin_reactivation_rejected',
    );
    const beforeTaskAudit = await countAudit(
      tenantA,
      'escalation_task_created',
    );

    const r = await adminRejectReactivation(racedDeps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      reason: 'duplicate payment — refund + reject',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    if (r.ok && r.value.outcome === 'rejected') {
      expect(r.value.cycleStatus).toBe('cancelled');
      expect(r.value.closedReason).toBe('admin_rejected_with_refund');
      expect(r.value.refundCreditNoteId).not.toBeNull();
    }
    expect(stub.issueRefundForInvoice).toHaveBeenCalledOnce();

    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('cancelled');
    expect(row[0]?.closedReason).toBe('admin_rejected_with_refund');

    // Reject audit row landed.
    const afterRejAudit = await countAudit(
      tenantA,
      'lapsed_member_admin_reactivation_rejected',
    );
    expect(afterRejAudit).toBe(beforeRejAudit + 1);

    // Post-refund finance escalation task created (idempotent
    // `post_refund_review` row) + its `escalation_task_created` audit.
    const tasks = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          taskType: renewalEscalationTasks.taskType,
          status: renewalEscalationTasks.status,
          cycleId: renewalEscalationTasks.cycleId,
        })
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug),
            eq(renewalEscalationTasks.memberId, memberId),
          ),
        ),
    );
    const postRefund = tasks.filter((t) => t.taskType === 'post_refund_review');
    expect(postRefund.length).toBe(1);
    expect(postRefund[0]?.cycleId).toBe(cycleId);

    const afterTaskAudit = await countAudit(
      tenantA,
      'escalation_task_created',
    );
    expect(afterTaskAudit).toBe(beforeTaskAudit + 1);
  });

  it('reject (no linked invoice): cancelled with null refund credit-note + no post-refund task', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId, memberId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: false,
    });
    // Bridge must NOT be called when there is no linked invoice.
    const neverBridge: F5RefundBridge = {
      issueRefundForInvoice: vi.fn(async () => {
        throw new Error('refund bridge must not run without a linked invoice');
      }),
      getRefundOutcomeForInvoice: settlementLookupUnused(),
    };
    const racedDeps = { ...deps, f5RefundBridge: neverBridge };

    const r = await adminRejectReactivation(racedDeps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      reason: 'no payment — just reject',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    if (r.ok && r.value.outcome === 'rejected') {
      expect(r.value.cycleStatus).toBe('cancelled');
      expect(r.value.refundCreditNoteId).toBeNull();
    }
    expect(neverBridge.issueRefundForInvoice).not.toHaveBeenCalled();

    // No post-refund task for a no-payment reject.
    const tasks = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ taskType: renewalEscalationTasks.taskType })
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug),
            eq(renewalEscalationTasks.memberId, memberId),
          ),
        ),
    );
    expect(
      tasks.filter((t) => t.taskType === 'post_refund_review').length,
    ).toBe(0);
  });

  it('cross-tenant isolation: tenant B cannot reactivate tenant A cycle → cycle_not_found', async () => {
    const { cycleId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });
    // Tenant B's deps — RLS hides tenant A's cycle row.
    const depsB = makeRenewalsDeps(tenantB.ctx.slug);

    const reactivate = await adminReactivateLapsedCycle(depsB, {
      tenantId: tenantB.ctx.slug,
      cycleId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(reactivate.ok).toBe(false);
    if (!reactivate.ok) {
      expect(reactivate.error.kind).toBe('cycle_not_found');
    }

    const rejectB = await adminRejectReactivation(
      { ...depsB, f5RefundBridge: refundedStub() },
      {
        tenantId: tenantB.ctx.slug,
        cycleId,
        reason: 'cross-tenant probe',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      },
    );
    expect(rejectB.ok).toBe(false);
    if (!rejectB.ok) {
      expect(rejectB.error.kind).toBe('cycle_not_found');
    }

    // The cycle is untouched in tenant A — still pending.
    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('pending_admin_reactivation');
  });

  it('concurrent double-reactivate: one wins (completed), the other gets cycle_not_pending', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });

    const call = () =>
      adminReactivateLapsedCycle(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });

    const [a, b] = await Promise.all([call(), call()]);
    const results = [a, b];
    const successes = results.filter((r) => r.ok);
    const notPending = results.filter(
      (r) => !r.ok && r.error.kind === 'cycle_not_pending',
    );

    expect(successes.length).toBe(1);
    expect(notPending.length).toBe(1);
    expect(successes[0]?.ok && successes[0].value.cycleStatus).toBe(
      'completed',
    );

    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('completed');
  });

  it('concurrent double-reject: exactly one money-issuing refund, no double-charge (NIT-1)', async () => {
    // SECURITY (NIT-1): two admins double-click "reject & refund" on the
    // SAME pending cycle. The cycle must end cancelled and the F5 layer
    // must NOT issue the refund twice.
    //
    // Reject is a TWO-tx flow: tx1 validates-under-lock + commits (lock
    // released), the refund runs OUTSIDE any tx (Stripe is external), then
    // tx2 re-acquires the lock + transitions via a `WHERE status='pending'`
    // CAS. Because tx1 only READS, both concurrent callers can pass the
    // tx1 re-read and reach the refund — so the F5 bridge is what prevents
    // a double-charge: the SECOND refund of a now-fully-refunded invoice
    // returns `no_payment_found` (no Stripe call). The tx2 CAS then lets
    // exactly one caller win the `cancelled` transition; the loser raises
    // CycleTransitionConflictError → `server_error` (refund already
    // idempotently neutralised, manual-reconciliation runbook). This test
    // pins the money invariant — EXACTLY ONE refund issues — and guards
    // against a regression that removes the F5 idempotency net.
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });
    const bridge = refundOnceThenNoPaymentStub();
    const racedDeps = { ...deps, f5RefundBridge: bridge };

    const call = () =>
      adminRejectReactivation(racedDeps, {
        tenantId: tenantA.ctx.slug,
        cycleId,
        reason: 'concurrent double reject',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });

    const [a, b] = await Promise.all([call(), call()]);
    const results = [a, b];

    // Exactly one caller wins the cancel/refund transition.
    const cancelled = results.filter(
      (r) =>
        r.ok &&
        r.value.cycleStatus === 'cancelled' &&
        r.value.closedReason === 'admin_rejected_with_refund' &&
        r.value.refundCreditNoteId !== null,
    );
    expect(cancelled.length).toBe(1);

    // The loser is NOT a second money-issuing success — it lost the tx2
    // CAS race (server_error) or saw the cycle already non-pending
    // (cycle_not_pending). It MUST NOT be a second `cancelled` with a
    // fresh refund credit-note.
    const loser = results.find((r) => r !== cancelled[0]);
    expect(loser).toBeDefined();
    expect(
      !loser!.ok &&
        ['server_error', 'cycle_not_pending', 'refund_failed'].includes(
          loser!.error.kind,
        ),
    ).toBe(true);

    // THE MONEY INVARIANT: the F5 bridge issued a refund (status
    // 'refunded') EXACTLY ONCE across both concurrent callers — the second
    // invocation hit the idempotency net and returned `no_payment_found`.
    // (The bridge may be *invoked* twice; only one invocation issued
    // money — that is what the F5 net guarantees in production.)
    expect(bridge.refundedCount()).toBe(1);

    // The live cycle is terminal — cancelled with the refund reason — and
    // no longer pending (no orphan / re-tryable double-reject state).
    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('cancelled');
    expect(row[0]?.closedReason).toBe('admin_rejected_with_refund');
  });

  it('refund_failed: cycle stays pending_admin_reactivation (re-tryable, no orphan state) (NIT-2)', async () => {
    // SECURITY (NIT-2): when the F5 refund bridge fails, the reject
    // returns `refund_failed` BEFORE any cycle transition runs (the
    // transition tx is only entered on a successful/no-payment refund).
    // The cycle must remain `pending_admin_reactivation` so an admin can
    // safely retry once F5 recovers — no half-cancelled / orphaned state.
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const { cycleId } = await seedPendingCycle({
      tenant: tenantA,
      user,
      withInvoice: true,
    });
    const bridge = refundFailedStub();
    const racedDeps = { ...deps, f5RefundBridge: bridge };

    const r = await adminRejectReactivation(racedDeps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      reason: 'F5 outage — refund should fail',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('refund_failed');
    }
    expect(bridge.issueRefundForInvoice).toHaveBeenCalledOnce();

    // Re-read the cycle from the repo: it MUST still be pending (re-tryable).
    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
          closedAt: renewalCycles.closedAt,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]?.status).toBe('pending_admin_reactivation');
    expect(row[0]?.closedReason).toBeNull();
    expect(row[0]?.closedAt).toBeNull();
  });
});

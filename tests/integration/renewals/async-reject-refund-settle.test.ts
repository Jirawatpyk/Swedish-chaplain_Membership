/**
 * F8-RP follow-up — async reject-with-refund SETTLES to `cancelled`, not
 * `lapsed` (live Neon Singapore).
 *
 * THE GAP: when an admin REJECTS a `pending_admin_reactivation` cycle WITH a
 * refund that F5 settles ASYNCHRONOUSLY (Stripe pending/requires_action), the
 * reject use-case leaves the cycle `pending_admin_reactivation` (F8-RP added no
 * new sub-state). Before this change the cycle then just waited for the 30-day
 * `reconcile-pending-reactivations` timeout → `lapsed` — the WRONG terminal
 * (the admin's intent was `cancelled`/`admin_rejected_with_refund`).
 *
 * THE FIX (migration 0243 marker + cron settle branch): the reject use-case
 * stamps a durable marker (`reject_refund_initiated_at` + `reject_refund_id` +
 * `reject_actor_user_id`); the reconcile cron detects the SETTLED refund EVERY
 * pass (not 30d-gated) and converges the MARKED cycle → `cancelled` with the
 * SYNC reject path's EXACT terminal fields (closed_reason, closed_at, the
 * `_rejected` audit carrying the settled refund's credit-note id + the
 * REPLAYED rejecting admin as actor, and the `post_refund_review` escalation
 * task). An UNMARKED genuine timeout still → `lapsed`.
 *
 * These tests exercise the full round-trip on live Postgres so the marker
 * columns, RLS, the cycle-state transition, the in-tx audit emit, and the
 * escalation-task insert are all validated (unit mocks hide every one). The F5
 * bridge is STUBBED per-test (same pattern as the sibling reject / timeout-race
 * integration tests) so no real Stripe call is made — the SETTLEMENT is modelled
 * by the stub's `getRefundOutcomeForInvoice` result.
 *
 * Cross-tenant (Constitution Principle I, Review-Gate blocker): a marked cycle
 * in tenant A is NOT reconciled/cancelled when the cron runs under tenant B.
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
  adminRejectReactivation,
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { F5RefundBridge } from '@/modules/renewals/application/ports/f5-refund-bridge';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const NOW = new Date('2026-05-15T07:00:00Z');
const MS_PER_DAY = 86_400_000;

interface SeedArgs {
  readonly tenant: TestTenant;
  readonly user: TestUser;
  readonly daysPending: number;
  /** F8-RP async reject-with-refund marker to pre-stamp on the seeded row. */
  readonly marker?: { readonly refundId: string; readonly actorUserId: string };
}

interface Seeded {
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string;
}

/** Seed a pending_admin_reactivation cycle linked to a draft membership invoice. */
async function seedCycle(args: SeedArgs): Promise<Seeded> {
  const { tenant, user, daysPending, marker } = args;
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const invoiceId = randomUUID();
  const planId = `f8rp-${randomUUID().slice(0, 8)}`;

  await runInTenant(tenant.ctx, (tx) =>
    seedF8MembershipPlan(tx, {
      tenantSlug: tenant.ctx.slug,
      planId,
      planName: { en: 'Async Reject Plan' },
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      createdBy: user.userId,
    }),
  );
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Async Reject Co',
      country: 'TH',
      planId,
      planYear: 2026,
    }),
  );
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
      enteredPendingAt: new Date(NOW.getTime() - daysPending * MS_PER_DAY),
      linkedInvoiceId: invoiceId,
      ...(marker
        ? {
            rejectRefundInitiatedAt: new Date(
              NOW.getTime() - (daysPending - 1) * MS_PER_DAY,
            ),
            rejectRefundId: marker.refundId,
            rejectActorUserId: marker.actorUserId,
          }
        : {}),
    }),
  );
  return { memberId, cycleId, invoiceId };
}

/** A bridge stub whose settlement lookup returns a fixed outcome. */
function bridgeWithSettlement(
  outcome: Awaited<
    ReturnType<F5RefundBridge['getRefundOutcomeForInvoice']>
  >,
): F5RefundBridge {
  return {
    // The cron settle branch never calls issueRefundForInvoice; make it loud
    // if it ever does (would signal the marked branch fell through to timeout).
    issueRefundForInvoice: vi.fn(async () => {
      throw new Error(
        'issueRefundForInvoice must not run on the async-settle branch',
      );
    }),
    getRefundOutcomeForInvoice: vi.fn(async () => outcome),
  };
}

async function readCycle(tenant: TestTenant, cycleId: string) {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({
        status: renewalCycles.status,
        closedReason: renewalCycles.closedReason,
        closedAt: renewalCycles.closedAt,
        rejectRefundInitiatedAt: renewalCycles.rejectRefundInitiatedAt,
        rejectRefundId: renewalCycles.rejectRefundId,
        rejectActorUserId: renewalCycles.rejectActorUserId,
      })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId))
      .limit(1),
  );
  return rows[0];
}

describe('F8-RP async reject-with-refund settles to cancelled (live Neon)', () => {
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

  it('reject use-case STAMPS the marker on the live row when F5 returns refund_pending', async () => {
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 3,
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const asyncRefundId = `rfnd_async_${randomUUID().slice(0, 8)}`;
    const racedDeps: typeof deps = {
      ...deps,
      f5RefundBridge: {
        issueRefundForInvoice: vi.fn(async () => ({
          status: 'refund_pending' as const,
          refundId: asyncRefundId,
          processorRefundId: 're_async_live_1',
        })),
        getRefundOutcomeForInvoice: vi.fn(async () => ({
          status: 'not_found' as const,
        })),
      },
    };

    const r = await adminRejectReactivation(racedDeps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      reason: 'fraud flag — async refund',
      actorUserId: user.userId,
      actorRole: 'admin',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('refund_pending');

    // The LIVE row still pending, now carrying the durable marker.
    const row = await readCycle(tenantA, cycleId);
    expect(row?.status).toBe('pending_admin_reactivation');
    expect(row?.rejectRefundInitiatedAt).not.toBeNull();
    expect(row?.rejectRefundId).toBe(asyncRefundId);
    expect(row?.rejectActorUserId).toBe(user.userId);
  });

  it('cron converges a MARKED cycle whose refund SETTLED → cancelled with the sync path exact terminal', async () => {
    const settledRefundId = `rfnd_settle_${randomUUID().slice(0, 8)}`;
    const creditNoteId = randomUUID();
    const { cycleId, memberId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4, // far below the 30-day timeout — settles NOW
      marker: { refundId: settledRefundId, actorUserId: user.userId },
    });

    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const racedDeps: typeof deps = {
      ...deps,
      f5RefundBridge: bridgeWithSettlement({
        status: 'succeeded',
        creditNoteId,
      }),
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectSettledCancelled).toBe(1);
      expect(r.value.timedOut).toBe(0);
    }

    // Terminal byte-identical to the SYNC reject path.
    const row = await readCycle(tenantA, cycleId);
    expect(row?.status).toBe('cancelled');
    expect(row?.closedReason).toBe('admin_rejected_with_refund');
    expect(row?.closedAt).not.toBeNull();

    // `_rejected` audit with the settled CN id AND the REPLAYED admin actor.
    const rejectedAudit = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          actorUserId: auditLog.actorUserId,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            // audit_log pgEnum TS union lags the live DB enum for F8 event
            // types — cast to never (precedent: admin-reactivate-reject.test).
            eq(
              auditLog.eventType,
              'lapsed_member_admin_reactivation_rejected' as never,
            ),
          ),
        )
        .limit(1),
    );
    expect(rejectedAudit[0]?.actorUserId).toBe(user.userId);
    expect(
      (rejectedAudit[0]?.payload as { refund_credit_note_id?: string })
        ?.refund_credit_note_id,
    ).toBe(creditNoteId);

    // post_refund_review escalation task inserted (finance parity).
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
    expect(tasks.map((t) => t.taskType)).toContain('post_refund_review');
  });

  it('REGRESSION: an UNMARKED genuine timeout (31 days) still → lapsed, not cancelled', async () => {
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 31, // past the 30-day timeout, NO marker
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    // Real timeout path issues a refund via F5; stub it to no_payment_found so
    // the cycle lapses without a Stripe call. Settlement lookup is never used.
    const racedDeps: typeof deps = {
      ...deps,
      f5RefundBridge: {
        issueRefundForInvoice: vi.fn(async () => ({
          status: 'no_payment_found' as const,
        })),
        getRefundOutcomeForInvoice: vi.fn(async () => {
          throw new Error(
            'settlement lookup must not run for an unmarked timeout',
          );
        }),
      },
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timedOut).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
    }
    const row = await readCycle(tenantA, cycleId);
    expect(row?.status).toBe('lapsed');
    expect(row?.closedReason).toBe('pending_reactivation_timed_out');
  });

  it('marked cycle whose refund SETTLED FAILED → marker cleared, cycle stays pending (never cancelled/lapsed)', async () => {
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4,
      marker: {
        refundId: `rfnd_fail_${randomUUID().slice(0, 8)}`,
        actorUserId: user.userId,
      },
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const racedDeps: typeof deps = {
      ...deps,
      f5RefundBridge: bridgeWithSettlement({
        status: 'failed',
        failureReasonCode: 'stripe_refund_failed',
      }),
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectRefundFailed).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
      expect(r.value.timedOut).toBe(0);
    }

    // The cycle reverts to an ordinary pending row — marker cleared, NOT
    // cancelled and NOT lapsed.
    const row = await readCycle(tenantA, cycleId);
    expect(row?.status).toBe('pending_admin_reactivation');
    expect(row?.rejectRefundInitiatedAt).toBeNull();
    expect(row?.rejectRefundId).toBeNull();
    expect(row?.rejectActorUserId).toBeNull();
  });

  it('cross-tenant isolation: tenant B cron does NOT settle tenant A marked cycle (Principle I)', async () => {
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4,
      marker: {
        refundId: `rfnd_xt_${randomUUID().slice(0, 8)}`,
        actorUserId: user.userId,
      },
    });

    // Run the cron under TENANT B — a bridge that would settle-cancel ANY
    // cycle it sees. RLS must scope tenant B's `list` to tenant B only, so
    // tenant A's marked cycle is never reached.
    const depsB = makeRenewalsDeps(tenantB.ctx.slug);
    const racedDepsB: typeof depsB = {
      ...depsB,
      f5RefundBridge: bridgeWithSettlement({
        status: 'succeeded',
        creditNoteId: randomUUID(),
      }),
    };
    const r = await reconcilePendingReactivations(racedDepsB, {
      tenantId: tenantB.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.asyncRejectSettledCancelled).toBe(0);

    // Tenant A's cycle is untouched — still pending, marker intact.
    const row = await readCycle(tenantA, cycleId);
    expect(row?.status).toBe('pending_admin_reactivation');
    expect(row?.rejectRefundInitiatedAt).not.toBeNull();
    expect(row?.rejectRefundId).not.toBeNull();
  });
});

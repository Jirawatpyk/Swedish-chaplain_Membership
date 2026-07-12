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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
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
    // The cron settle branch never resolves an in-flight refund (Finding 3 is
    // the admin-reject path) — stub it so the bridge satisfies the port.
    findPendingRefundForInvoice: vi.fn(async () => ({ status: 'none' as const })),
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

  // Each test seeds its own cycle(s) and asserts on the run's AGGREGATE
  // reconcile counters, so tenant state must be reset between tests — otherwise
  // a marked cycle left pending by an earlier test (e.g. the reject-marker
  // test) is re-processed by a later test's cron and skews its counter.
  afterEach(async () => {
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
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
  });

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
        // This path carries a refundId directly (kind:'pending'), so the
        // resolver is never reached; stub for port completeness.
        findPendingRefundForInvoice: vi.fn(async () => ({
          status: 'none' as const,
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
        findPendingRefundForInvoice: vi.fn(async () => {
          throw new Error(
            'in-flight resolver must not run for an unmarked timeout',
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

  it('Finding 3: reject hits refund_in_progress on an UNMARKED (cron-timeout) cycle → resolver STAMPS marker on the live row → next cron pass converges to cancelled (not lapsed)', async () => {
    // Reproduces the dropped-reject bug: the reconcile cron's day-30
    // `processTimeout` issued an async refund (settling) and left the cycle
    // UNMARKED. Then an admin clicks Reject while that refund is still settling
    // — F5's `issueRefund` returns `refund_in_progress` (no ids). Before the
    // fix, the reject skipped stamping → the next cron pass re-timed-out the
    // cycle → `lapsed` (actor=cron), silently dropping the reject. THE FIX:
    // the reject resolves the in-flight refund id via the bridge + stamps the
    // marker, so the marked branch converges the cycle → `cancelled`.
    const inflightRefundId = `rfnd_inflight_${randomUUID().slice(0, 8)}`;
    const creditNoteId = randomUUID();
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 31, // PAST the 30-day timeout — the pre-fix lapse trap
      // NO marker — the cron-timeout refund left it unmarked
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);

    // Admin reject: issueRefund → refund_in_progress (models F5's guard, no ids);
    // the resolver surfaces the in-flight refund id from F5 activity.
    const rejectDeps: typeof deps = {
      ...deps,
      f5RefundBridge: {
        issueRefundForInvoice: vi.fn(async () => ({
          status: 'refund_pending' as const, // refund_in_progress → no ids
        })),
        getRefundOutcomeForInvoice: vi.fn(async () => ({
          status: 'not_found' as const,
        })),
        findPendingRefundForInvoice: vi.fn(async () => ({
          status: 'found' as const,
          refundId: inflightRefundId,
          processorRefundId: 're_inflight_live_1',
        })),
      },
    };
    const rejectResult = await adminRejectReactivation(rejectDeps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      reason: 'fraud flag — reject while cron refund settling',
      actorUserId: user.userId,
      actorRole: 'admin',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(rejectResult.ok).toBe(true);
    if (rejectResult.ok) {
      expect(rejectResult.value.outcome).toBe('refund_pending');
    }

    // The LIVE row is now MARKED with the RESOLVED in-flight refund id + admin.
    const marked = await readCycle(tenantA, cycleId);
    expect(marked?.status).toBe('pending_admin_reactivation');
    expect(marked?.rejectRefundInitiatedAt).not.toBeNull();
    expect(marked?.rejectRefundId).toBe(inflightRefundId);
    expect(marked?.rejectActorUserId).toBe(user.userId);

    // Next cron pass: the refund settled succeeded → the marked branch converges
    // the cycle → `cancelled` (NOT lapsed), even though it is 31 days pending.
    const cronDeps: typeof deps = {
      ...deps,
      f5RefundBridge: bridgeWithSettlement({
        status: 'succeeded',
        creditNoteId,
      }),
    };
    const cronResult = await reconcilePendingReactivations(cronDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(cronResult.ok).toBe(true);
    if (cronResult.ok) {
      expect(cronResult.value.asyncRejectSettledCancelled).toBe(1);
      expect(cronResult.value.timedOut).toBe(0); // NOT lapsed despite day 31
    }
    const converged = await readCycle(tenantA, cycleId);
    expect(converged?.status).toBe('cancelled');
    expect(converged?.closedReason).toBe('admin_rejected_with_refund');
  });

  it('Finding 5: clearRejectRefundMarkerInTx is guarded on the refund id — a clear for R1 is a no-op when the live marker holds a newer R2 (marker survives)', async () => {
    // The FAILED branch reads settlement for R1 OUTSIDE the lock, then clears
    // under the lock. If a concurrent re-reject overwrote the marker with a
    // fresh R2 in that window, the R1-guarded clear must be a no-op so R2's
    // marker SURVIVES — otherwise R2's real in-flight refund is orphaned and the
    // cycle lapses instead of converging. Direct repo test on live Neon (the
    // WHERE-clause behaviour mocks hide).
    const r2 = `rfnd_r2_${randomUUID().slice(0, 8)}`;
    const { cycleId } = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4,
      marker: { refundId: r2, actorUserId: user.userId }, // live marker = R2
    });
    const repo = makeDrizzleRenewalCycleRepo(tenantA.ctx);
    const r1 = `rfnd_r1_${randomUUID().slice(0, 8)}`; // the STALE id the FAILED branch resolved

    const clearedForR1 = await runInTenant(tenantA.ctx, async (tx) => {
      await repo.acquireCycleLockInTx(tx, tenantA.ctx.slug, asCycleId(cycleId));
      return repo.clearRejectRefundMarkerInTx(
        tx,
        tenantA.ctx.slug,
        asCycleId(cycleId),
        r1, // clearing for R1 while the live marker holds R2
      );
    });
    expect(clearedForR1).toBe(false); // no-op: WHERE reject_refund_id = R1 → 0 rows

    // R2's marker SURVIVES — the cycle stays marked so R2 still converges.
    const survived = await readCycle(tenantA, cycleId);
    expect(survived?.rejectRefundInitiatedAt).not.toBeNull();
    expect(survived?.rejectRefundId).toBe(r2);

    // Sanity: clearing for the CORRECT id (R2) DOES clear it.
    const clearedForR2 = await runInTenant(tenantA.ctx, async (tx) => {
      await repo.acquireCycleLockInTx(tx, tenantA.ctx.slug, asCycleId(cycleId));
      return repo.clearRejectRefundMarkerInTx(
        tx,
        tenantA.ctx.slug,
        asCycleId(cycleId),
        r2,
      );
    });
    expect(clearedForR2).toBe(true);
    const afterClear = await readCycle(tenantA, cycleId);
    expect(afterClear?.rejectRefundInitiatedAt).toBeNull();
    expect(afterClear?.rejectRefundId).toBeNull();
  });

  it('Finding 1: a settled-FAILED marker-clear throw is per-cycle isolated (live Neon) — poison cycle rolls back with marker intact, a second cycle still converges', async () => {
    // Two marked cycles in tenant A: cycle 1's refund settled FAILED and its
    // marker-clear tx THROWS (injected persistent DB blip); cycle 2's refund
    // settled SUCCEEDED. BEFORE the fix, the bare `runInTenant` in the FAILED
    // branch let the throw escape → the caller's unguarded for-loop → the whole
    // reconcile pass 500'd (self-DoS). THE FIX isolates it: cycle 1 →
    // `settle_failed` with its marker INTACT (the throwing clear-tx rolled back
    // on live Neon), and cycle 2 still converges → `cancelled`.
    const poisonRefundId = `rfnd_poison_${randomUUID().slice(0, 8)}`;
    const okRefundId = `rfnd_ok_${randomUUID().slice(0, 8)}`;
    const okCreditNoteId = randomUUID();
    const poison = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4,
      marker: { refundId: poisonRefundId, actorUserId: user.userId },
    });
    const healthy = await seedCycle({
      tenant: tenantA,
      user,
      daysPending: 4,
      marker: { refundId: okRefundId, actorUserId: user.userId },
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const racedDeps: typeof deps = {
      ...deps,
      f5RefundBridge: {
        issueRefundForInvoice: vi.fn(async () => {
          throw new Error('issueRefundForInvoice must not run on the settle branch');
        }),
        // Per-invoice settlement: poison → failed (drives the FAILED branch);
        // healthy → succeeded (drives the convergence branch).
        getRefundOutcomeForInvoice: vi.fn(async (input) =>
          input.invoiceId === poison.invoiceId
            ? {
                status: 'failed' as const,
                failureReasonCode: 'stripe_refund_failed',
              }
            : { status: 'succeeded' as const, creditNoteId: okCreditNoteId },
        ),
        findPendingRefundForInvoice: vi.fn(async () => ({
          status: 'none' as const,
        })),
      },
      cyclesRepo: {
        ...deps.cyclesRepo,
        // Inject a persistent throw on the FAILED-branch marker clear — the
        // exact self-DoS class Finding 1 isolates. Real repo for every other op.
        clearRejectRefundMarkerInTx: vi.fn(async () => {
          throw new Error('renewal_cycles: connection reset mid-clear-tx');
        }),
      },
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });

    // The run does NOT reject despite the poison cycle's clear throwing.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectSettleFailed).toBe(1); // poison isolated
      expect(r.value.asyncRejectSettledCancelled).toBe(1); // healthy converged
      expect(r.value.timedOut).toBe(0);
    }

    // Poison cycle: the throwing clear-tx rolled back → marker INTACT, still
    // pending (self-heals on a later pass).
    const poisonRow = await readCycle(tenantA, poison.cycleId);
    expect(poisonRow?.status).toBe('pending_admin_reactivation');
    expect(poisonRow?.rejectRefundInitiatedAt).not.toBeNull();
    expect(poisonRow?.rejectRefundId).toBe(poisonRefundId);

    // Healthy cycle: converged to cancelled in the SAME run — not blocked by
    // the poison cycle's throw.
    const healthyRow = await readCycle(tenantA, healthy.cycleId);
    expect(healthyRow?.status).toBe('cancelled');
    expect(healthyRow?.closedReason).toBe('admin_rejected_with_refund');
  });

  it('H1: a timeout cycle whose Step-1 re-read THROWS is per-cycle isolated (live Neon) — pass does not 500, a second reminder-due cycle still processes', async () => {
    // H1 reliability fix (live Neon). `processTimeout` Step-1 (the
    // validate-under-lock re-read) opens an UNGUARDED `runInTenant`
    // (`acquireCycleLockInTx` + `findByIdInTx`). A persistent NON-conflict throw
    // there escaped `processTimeout` → the caller for-loop (no top-level guard)
    // → the whole reconcile pass 500'd (self-DoS), blocking every OTHER cycle
    // for the tenant. THE FIX: a loop-level per-cycle backstop isolates ANY
    // escaped throw to its one cycle (distinct `cycleProcessingErrors` counter +
    // ERROR log), then continues.
    //
    // Two UNMARKED cycles in tenant A: a day-31 timeout cycle whose Step-1
    // re-read is injected to throw (poison), and a day-23 reminder-due cycle
    // seeded AFTER it. The reminder cycle never calls `findByIdInTx`, so only
    // the poison timeout cycle hits the injected throw. `findByIdInTx` is
    // scoped to the poison cycle's id and delegates to the real repo otherwise.
    const poison = await seedCycle({ tenant: tenantA, user, daysPending: 31 });
    const healthy = await seedCycle({ tenant: tenantA, user, daysPending: 23 });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const realFindById = deps.cyclesRepo.findByIdInTx;
    const racedDeps: typeof deps = {
      ...deps,
      // Timeout path issues a refund via F5; stub it loud so a bug that reaches
      // the refund (Step-1 did NOT throw) is caught. Step-1 throws first, so it
      // must never run.
      f5RefundBridge: {
        issueRefundForInvoice: vi.fn(async () => {
          throw new Error('issueRefundForInvoice must not run — Step-1 throws first');
        }),
        getRefundOutcomeForInvoice: vi.fn(async () => ({ status: 'not_found' as const })),
        findPendingRefundForInvoice: vi.fn(async () => ({ status: 'none' as const })),
      },
      cyclesRepo: {
        ...deps.cyclesRepo,
        findByIdInTx: vi.fn(async (tx: unknown, tid: string, cid: string) => {
          if (cid === poison.cycleId) {
            throw new Error('renewal_cycles: connection reset mid-Step-1-reread');
          }
          return realFindById(tx as never, tid, cid as never);
        }),
      },
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });

    // The run does NOT reject despite the poison cycle's Step-1 throwing.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cycleProcessingErrors).toBe(1); // poison isolated
      expect(r.value.remindersT7).toBe(1); // healthy reminder cycle processed
      expect(r.value.timedOut).toBe(0); // poison never lapsed
    }

    // Poison cycle: Step-1 is read-only + rolled back → row untouched, still
    // pending (self-heals on a later pass).
    const poisonRow = await readCycle(tenantA, poison.cycleId);
    expect(poisonRow?.status).toBe('pending_admin_reactivation');
    // Healthy cycle: reminders never transition — still pending, but its T-7
    // reminder audit row landed on live Neon (proof the loop processed it).
    const healthyRow = await readCycle(tenantA, healthy.cycleId);
    expect(healthyRow?.status).toBe('pending_admin_reactivation');
    const reminderAudit = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(
              auditLog.eventType,
              'lapsed_member_admin_reactivation_reminder_t-7' as never,
            ),
          ),
        )
        .limit(1),
    );
    expect(reminderAudit.length).toBe(1);
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

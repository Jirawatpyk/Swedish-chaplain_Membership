/**
 * F8 · 063-renewal-audit-fixes — money-safety race in the pending-
 * reactivation timeout-refund path (live Neon).
 *
 * THE BUG (audit finding): `reconcilePendingReactivations.processTimeout`
 * issued the Stripe REFUND for a timed-out `pending_admin_reactivation`
 * cycle BEFORE acquiring the per-cycle advisory lock + re-confirming the
 * cycle was still pending. If an admin APPROVED the reactivation in the
 * race window (the member paid + was reactivated → cycle `completed`),
 * the cron clawed their money back.
 *
 * THE FIX: `processTimeout` now re-confirms the cycle is STILL
 * `pending_admin_reactivation` UNDER the advisory lock (tx1) BEFORE the
 * refund — mirroring `adminRejectReactivation`'s validate-under-lock →
 * refund-outside-tx → transition-in-tx ordering. A non-pending re-read
 * short-circuits to `admin_race_skipped` (no refund, no transition).
 *
 * THIS TEST exercises the canonical IN-FLIGHT race on live Postgres:
 *   1. Seed a pending cycle PAST the 30-day timeout, linked to a (draft)
 *      F4 invoice so the timeout path WOULD reach the refund bridge.
 *   2. Simulate the admin WINNING the race AFTER the cron has already
 *      listed the cycle: run `adminReactivateLapsedCycle` → the live DB
 *      row transitions `pending_admin_reactivation` → `completed`
 *      (closed_reason='admin_reactivated').
 *   3. Run `reconcilePendingReactivations` with `cyclesRepo.list`
 *      overridden to return the STALE pending snapshot (modelling "the
 *      cron's list query ran before the admin approval, so the cron saw
 *      the cycle as still pending") + a SPY refund bridge. The tx-bound
 *      re-read inside `processTimeout` hits the LIVE row (now completed).
 *   4. Assert: the spy was NEVER called (no refund), the cycle stays
 *      `completed`/`admin_reactivated`, and the cron reports
 *      `timeoutAdminRaceSkipped=1` / `timedOut=0`.
 *
 * The stale-list snapshot is the faithful reproduction of the race the
 * audit found: the cron sees the cycle as pending (it was, at list time)
 * but the admin's approval lands before the cron acquires the per-cycle
 * lock. The guard's tx-bound re-read UNDER the lock observes `completed`
 * and short-circuits to `admin_race_skipped`.
 *
 * The spy assertion is stronger than "Stripe not hit": it proves the
 * guard short-circuits BEFORE the F5 bridge boundary, so no refund can
 * ever be attempted against an admin-approved cycle.
 *
 * The legacy ordering (refund-before-lock) would call the spy bridge
 * here → the spy throws → the test goes red, RED-proving the regression.
 *
 * 063 xhigh follow-up — a SECOND test in this file covers the POST-refund
 * Step-3 residual: tx1 sees the cycle STILL pending → the cron issues the
 * refund → an admin approves in the window between the refund and tx2's
 * lock (injected via the stub refund bridge's side effect) → tx2 observes
 * `completed` and short-circuits. Asserts the cron reports
 * `timeoutRefundOrphaned=1` (NOT `timedOut`, NOT `timeoutRefundFailures`,
 * NOT the Step-1 `timeoutAdminRaceSkipped`) so the money window — refunded
 * money on an admin-approved (now-terminal) cycle, the accepted residual
 * per #6 — is observable rather than hidden as a benign timeout.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { parseThbDecimal } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  adminReactivateLapsedCycle,
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { F5RefundBridge } from '@/modules/renewals/application/ports/f5-refund-bridge';
import {
  asCycleId,
  type RenewalCycle,
} from '@/modules/renewals/domain/renewal-cycle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 reconcilePendingReactivations — admin-approve-before-lock money safety (063)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const cycleId = randomUUID();
  const NOW = new Date('2026-05-15T07:00:00Z');
  // 31 days pending → past the 30-day PENDING_TIMEOUT_DAYS boundary.
  const enteredPendingAt = new Date(NOW.getTime() - 31 * 86_400_000);

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    const planId = `f8-race-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Race Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Race Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // Seed a minimal DRAFT membership invoice so the cycle's
    // `linked_invoice_id` FK resolves AND the `completed` CHECK
    // (`renewal_cycles_completed_requires_invoice_check`) is satisfiable.
    // Draft status sidesteps the non-draft snapshot/numbering CHECKs;
    // the `invoices_subject_fields_ck` for 'membership' only needs
    // member_id + plan_id + plan_year (all set below).
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
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

    // Seed the pending cycle past timeout, linked to the invoice.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
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
        enteredPendingAt,
        linkedInvoiceId: invoiceId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('admin approves before the cron lock → cron does NOT refund; cycle stays completed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);

    // --- Step A: admin WINS the race — approve the pending reactivation.
    // Cycle pending_admin_reactivation → completed (admin_reactivated).
    const approve = await adminReactivateLapsedCycle(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(approve.ok).toBe(true);
    if (approve.ok) {
      expect(approve.value.cycleStatus).toBe('completed');
      expect(approve.value.closedReason).toBe('admin_reactivated');
    }

    // --- Step B: cron runs AFTER the admin approval, but its list query
    // is modelled as having run BEFORE the approval (it saw the cycle as
    // still pending). We inject that stale snapshot via a `list` override
    // so `processTimeout` is entered for this cycle; its tx-bound re-read
    // UNDER the lock then hits the LIVE row (now completed) and must
    // short-circuit before the refund. The SPY refund bridge throws if
    // invoked, so any refund attempt against the just-approved cycle
    // fails the test loudly (this is what the legacy refund-before-lock
    // ordering did).
    const stalePendingSnapshot: RenewalCycle = {
      tenantId: tenantA.ctx.slug,
      cycleId: asCycleId(cycleId),
      memberId,
      status: 'pending_admin_reactivation',
      periodFrom: '2026-01-01T00:00:00.000Z',
      periodTo: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: parseThbDecimal('50000.00'),
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      enteredPendingAt: enteredPendingAt.toISOString(),
      linkedInvoiceId: invoiceId,
      linkedCreditNoteId: null,
      anchoredAt: null,
      anchorInvoiceId: null,
      rejectRefundInitiatedAt: null,
      rejectRefundId: null,
      rejectActorUserId: null,
      closedAt: null,
      closedReason: null,
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    } as RenewalCycle;

    const refundSpy = vi.fn<F5RefundBridge['issueRefundForInvoice']>(
      async () => {
        throw new Error(
          'MONEY-SAFETY VIOLATION: refund bridge called for an admin-approved cycle',
        );
      },
    );
    const spyBridge: F5RefundBridge = {
      issueRefundForInvoice: refundSpy,
      // F8-RP follow-up — timeout path never calls the settlement lookup.
      getRefundOutcomeForInvoice: vi.fn(async () => ({
        status: 'not_found' as const,
      })),
    };

    const racedDeps = {
      ...deps,
      f5RefundBridge: spyBridge,
      cyclesRepo: {
        ...deps.cyclesRepo,
        // Stale snapshot: the cron's list ran before the admin approval.
        list: async () => ({ items: [stalePendingSnapshot], nextCursor: null }),
      } as typeof deps.cyclesRepo,
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    // INVARIANT: the refund bridge was NEVER reached — the validate-
    // under-lock re-read found the cycle non-pending and short-circuited.
    expect(refundSpy).not.toHaveBeenCalled();
    if (r.ok) {
      // The stale snapshot is the only listed cycle; the live re-read
      // finds it completed → skipped, not timed out, not refund-failed.
      expect(r.value.cyclesProcessed).toBe(1);
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
    }

    // --- Step C: the cycle is untouched by the cron — still completed,
    // still admin_reactivated. The cron did NOT lapse it.
    const after = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(after[0]?.status).toBe('completed');
    expect(after[0]?.closedReason).toBe('admin_reactivated');
  });

  it('Step-3: refund issues, THEN admin approves before tx2 lock → timeout_refund_orphaned=1 (NOT timed_out)', async () => {
    // 063 xhigh follow-up: the canonical POST-refund residual on live
    // Neon. Unlike the Step-1 test above (admin wins BEFORE the refund,
    // so the cron never reaches F5), here the cron's tx1 validate-under-
    // lock re-read finds the cycle STILL pending → the cron PROCEEDS to
    // issue the refund. The admin then approves in the window between the
    // refund and tx2's lock. The tx2 re-read observes `completed` and
    // short-circuits the transition.
    //
    // Timing injection: tx1 commits + releases the advisory lock, then
    // the refund bridge runs (no lock held). We hook the STUB refund
    // bridge to (a) perform the real `adminReactivateLapsedCycle` against
    // the live row — which can now acquire the freed lock — committing
    // `pending_admin_reactivation` → `completed`, then (b) return
    // `'refunded'`. So by the time tx2 re-acquires the lock + re-reads,
    // the LIVE row is `completed`. This is the faithful Step-3 ordering;
    // the admin's approve happens AFTER tx1 (lock free) and BEFORE tx2.
    const member2 = randomUUID();
    const invoice2 = randomUUID();
    const cycle2 = randomUUID();
    const planId2 = `f8-race3-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planId2,
        planName: { en: 'Race Plan 3' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: member2,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Race Co 3',
        country: 'TH',
        planId: planId2,
        planYear: 2026,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: invoice2,
        memberId: member2,
        planId: planId2,
        planYear: 2026,
        invoiceSubject: 'membership',
        status: 'draft',
        draftByUserId: user.userId,
        currency: 'THB',
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: cycle2,
        memberId: member2,
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
        enteredPendingAt,
        linkedInvoiceId: invoice2,
      }),
    );

    const deps = makeRenewalsDeps(tenantA.ctx.slug);

    // STUB refund bridge: returns `'refunded'` (no Stripe) AND performs
    // the admin-approve side effect — the precise Step-3 window injection
    // (after tx1's lock release, before tx2's lock re-acquire).
    let adminApprovedDuringRefund = false;
    const refundThenApprove = vi.fn<F5RefundBridge['issueRefundForInvoice']>(
      async () => {
        const approve = await adminReactivateLapsedCycle(deps, {
          tenantId: tenantA.ctx.slug,
          cycleId: cycle2,
          actorUserId: user.userId,
          actorRole: 'admin',
          correlationId: randomUUID(),
        });
        adminApprovedDuringRefund = approve.ok;
        return {
          status: 'refunded',
          refundId: randomUUID(),
          creditNoteId: randomUUID(),
          creditNoteNumber: 'CN-STEP3-1',
        };
      },
    );

    const racedDeps = {
      ...deps,
      f5RefundBridge: {
        issueRefundForInvoice: refundThenApprove,
        // F8-RP follow-up — timeout path never calls the settlement lookup.
        getRefundOutcomeForInvoice: vi.fn(async () => ({
          status: 'not_found' as const,
        })),
      },
    };

    const r = await reconcilePendingReactivations(racedDeps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    // The refund WAS reached (tx1 saw pending) and the admin approve ran
    // inside the refund window.
    expect(refundThenApprove).toHaveBeenCalledOnce();
    expect(adminApprovedDuringRefund).toBe(true);
    if (r.ok) {
      // The residual: refund issued, admin won tx2 → NOT a clean timeout,
      // NOT a refund failure, NOT the Step-1 (pre-refund) skip.
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(0);
      expect(r.value.timeoutRefundOrphaned).toBe(1);
    }

    // The cron did NOT lapse the cycle — the admin's approval stands.
    const after = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycle2))
        .limit(1),
    );
    expect(after[0]?.status).toBe('completed');
    expect(after[0]?.closedReason).toBe('admin_reactivated');
  });
});

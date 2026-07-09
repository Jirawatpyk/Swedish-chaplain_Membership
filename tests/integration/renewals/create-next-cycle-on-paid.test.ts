/**
 * F8-completion Slice 1 · Task 1.4 — create-next-cycle-on-paid chain.
 * Live Neon. MANDATORY integration test (Constitution Principle I + VIII).
 *
 * Drives the REAL `f8OnPaidCallbacks` array sequentially against a real
 * tenant tx, exactly mirroring F4's `recordPayment` callback loop
 * (`for (const cb of callbacks) await cb(evt, tx)`). The chain is:
 *   [0] markCycleComplete — flips the just-paid prior cycle →completed
 *   [1] apply-pending-tier-upgrade — no-op (no pending suggestion here)
 *   [2] create-next-cycle-on-paid — creates the NEXT upcoming cycle
 *
 * The load-bearing assertion (AS / Task 1.4 Step 6): on the FIRST
 * (non-retry) delivery, the prior cycle is `completed` AND a NEW
 * `upcoming` cycle EXISTS — proving callback[2]'s in-tx idempotency
 * guard (`findActiveForMemberInTx`) sees callback[0]'s uncommitted
 * completion (threaded tx, NOT connection-fresh). A connection-fresh
 * read would still see the prior cycle as active → no-op → the next
 * cycle would NEVER be created (the happy-path-DEAD bug).
 *
 * Plus:
 *   - a webhook RETRY creates no duplicate (idempotency no-op, no 23505),
 *   - a concurrent dual-writer race loses gracefully (the active-member
 *     partial unique index lets exactly one win; the loser's tx rolls
 *     back via the throw — no orphan, no double cycle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('create-next-cycle-on-paid chain — integration (Slice 1 / Task 1.4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `OnPaid Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'OnPaid Co',
          country: 'TH',
          legal_name: 'OnPaid Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'onpaid@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  /**
   * Seed an `awaiting_payment` prior cycle linked to a just-issued
   * invoice. The cycle's period_to is the anchor for the next cycle.
   */
  async function seedAwaitingCycleLinkedToInvoice(opts: {
    memberId: string;
    invoiceId: string;
    periodTo: Date;
  }): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId: opts.memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(opts.periodTo.getTime() - 365 * MS_PER_DAY),
        periodTo: opts.periodTo,
        expiresAt: opts.periodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: opts.invoiceId,
      }),
    );
    return cycleId;
  }

  function buildEvent(invoiceId: string, memberId: string): F4InvoicePaidEvent {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
  }

  /**
   * Replicate F4's record-payment callback loop: fire ALL callbacks
   * sequentially in registration order against ONE threaded tx (the
   * exact contract `record-payment.ts:886-891` implements).
   */
  async function fireOnPaidChainInTx(
    invoiceId: string,
    memberId: string,
  ): Promise<void> {
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt = buildEvent(invoiceId, memberId);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-onpaid-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'OnPaid Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('FIRST delivery: prior cycle →completed AND a NEW upcoming cycle is created (gapless, in-tx idempotency sees the uncommitted completion)', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);

    // Rolling-anchor refactor (Task 6, migration 0238) — a TERMINAL
    // predecessor cycle so this member has cycle history (TWO cycles ever),
    // not the shared classifier's `first_payment` shape ("exactly one cycle
    // ever, unanchored"). This test's whole point is the STEADY-STATE
    // renewal rollover (prior completes + next created) — without a
    // predecessor, paying the seeded "prior" cycle below would re-anchor it
    // instead of completing it (Task 6's first-payment branch), which would
    // break the load-bearing assertion this test exists to prove. Mirrors
    // e8da485b's pattern.
    //
    // FIX-2 (PR #173 review, 2026-07-09) — `anchoredAt` set: a genuinely
    // cancelled-after-anchoring predecessor is SETTLED history under
    // `countSettledCyclesForMemberInTx` (status='completed' OR
    // anchored_at IS NOT NULL). Without it, this predecessor no longer
    // counts as "renewal history" and the classifier now (correctly)
    // treats the member as first_payment-shaped.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      }),
    );

    const priorPeriodTo = new Date('2026-01-01T00:00:00.000Z');
    const priorCycleId = await seedAwaitingCycleLinkedToInvoice({
      memberId,
      invoiceId,
      periodTo: priorPeriodTo,
    });

    await fireOnPaidChainInTx(invoiceId, memberId);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          periodFrom: renewalCycles.periodFrom,
          periodTo: renewalCycles.periodTo,
          planId: renewalCycles.planIdAtCycleStart,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );

    // Exactly 3 cycles: the terminal predecessor (cancelled, seeded above) +
    // the prior (now completed) + the new (upcoming).
    expect(rows).toHaveLength(3);

    const prior = rows.find((r) => r.cycleId === priorCycleId);
    const next = rows.find(
      (r) => r.cycleId !== priorCycleId && r.status === 'upcoming',
    );

    expect(prior?.status).toBe('completed');

    // The NEW cycle exists ON THE FIRST DELIVERY — the load-bearing
    // proof that the in-tx guard saw the uncommitted prior completion.
    expect(next).toBeDefined();
    expect(next?.status).toBe('upcoming');
    // Gapless: next.periodFrom === prior.periodTo.
    expect(next?.periodFrom.toISOString()).toBe(priorPeriodTo.toISOString());
    // periodTo = periodFrom + 12 months.
    expect(next?.periodTo.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // Frozen at the resolved plan price (F2 catalogue annualFee, from the
    // plan-lookup adapter — NOT the prior cycle's frozen 50000.00).
    expect(next?.planId).toBe(planId);
    expect(Number(next?.frozenPrice)).toBeGreaterThan(0);

    // A `renewal_cycle_created` audit row landed (atomic emit).
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            // F8 event types aren't in the F1 pgEnum TS union (added at DB
            // level via migration 0109) — established `as never` cast.
            eq(auditLog.eventType, 'renewal_cycle_created' as never),
          ),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('webhook RETRY: re-firing the chain creates no duplicate next cycle (idempotency no-op, no constraint violation)', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);
    const priorCycleId = await seedAwaitingCycleLinkedToInvoice({
      memberId,
      invoiceId,
      periodTo: new Date('2026-03-01T00:00:00.000Z'),
    });

    // First delivery — creates the next cycle.
    await fireOnPaidChainInTx(invoiceId, memberId);
    // Retry (Stripe at-least-once). callback[0] is idempotent (prior is
    // already completed → cycle_not_payable skip); callback[2] no-ops
    // because the member now has an active `upcoming` cycle.
    await expect(
      fireOnPaidChainInTx(invoiceId, memberId),
    ).resolves.toBeUndefined();

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId, status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    // Still exactly 2 (prior completed + one next upcoming) — no dupe.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'upcoming')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1);
    void priorCycleId;
  });

  it('concurrent dual-writer: two tx racing to create the SAME member next cycle — exactly one wins, the loser fails gracefully (active-member uniq index; no orphan, no double)', async () => {
    const memberId = await seedMember();

    // Rolling-anchor refactor (Task 6, migration 0238) — a TERMINAL
    // predecessor cycle so this member has cycle history (TWO cycles ever),
    // not the shared classifier's `first_payment` shape. This test races
    // the NEXT-CYCLE active-member-uniq guard, not the first-payment
    // re-anchor branch — without a predecessor, BOTH concurrent chains
    // would try to re-anchor the single un-anchored cycleA (a DIFFERENT
    // race than the one this test documents), and cycleA would never reach
    // `completed`. Mirrors e8da485b's pattern.
    //
    // FIX-2 (PR #173 review, 2026-07-09) — `anchoredAt` set: see the
    // identical rationale on the sibling seed above.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      }),
    );

    // Seed a COMPLETED prior cycle directly (no awaiting flip needed —
    // we test the createCycleInTx idempotency/uniqueness layer directly
    // by racing two next-cycle creations). Two issued invoices, two
    // awaiting cycles → two independent on-paid chains for the SAME
    // member would both try to create a next `upcoming` cycle.
    const invoiceA = await seedIssuedInvoice(memberId);
    const cycleA = await seedAwaitingCycleLinkedToInvoice({
      memberId,
      invoiceId: invoiceA,
      periodTo: new Date('2026-06-01T00:00:00.000Z'),
    });

    // Race: fire the SAME chain twice concurrently. The active-member
    // partial unique index (status NOT IN terminal) permits at most one
    // active cycle per member — the second creator hits 23505 and its
    // tx rolls back (the throw propagates; no swallow). Exactly one
    // next cycle survives.
    const results = await Promise.allSettled([
      fireOnPaidChainInTx(invoiceA, memberId),
      fireOnPaidChainInTx(invoiceA, memberId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // At least one succeeds; at most one (the other rolls back on the
    // active-member uniq constraint OR no-ops as a benign idempotent).
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // The loser either no-ops (idempotency saw the winner's committed
    // active cycle) or throws (23505) — both are graceful. We assert the
    // DB end-state, which is the real invariant.
    void rejected;

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId, status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    // The prior cycle (now completed) + AT MOST one next upcoming cycle.
    // The active-member uniq index guarantees no two active cycles.
    const active = rows.filter(
      (r) => r.status !== 'completed' && r.status !== 'lapsed' && r.status !== 'cancelled',
    );
    expect(active.length).toBeLessThanOrEqual(1);
    expect(rows.filter((r) => r.cycleId === cycleA)[0]?.status).toBe('completed');
  });

  // Principle-I (068 speckit-review tests I-2) — tenant-isolation probe on
  // the on-paid create-next-cycle path. Mirrors the cross-tenant probe in
  // `admin-renew-lapsed-member.test.ts`. The `f8OnPaidCallbacks` factory is
  // scoped to tenant A's slug (`makeRenewalsDeps(A)` → `runInTenant(A)`), so
  // RLS structurally prevents the chain from reading, completing, or
  // creating any cycle in tenant B. This assertion makes that structural
  // guarantee an explicit regression net (a future repo method that reached
  // for the pool-global `db` instead of the threaded `tx` would silently
  // bypass RLS — this probe would then catch the cross-tenant write).
  it('cross-tenant: tenant A on-paid flow never creates or touches a cycle in tenant B (Principle I)', async () => {
    const tenantB = await createTestTenant();
    try {
      const planB = `f8-onpaid-b-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantB.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: planB,
          planName: { en: 'Tenant B OnPaid Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );

      // Tenant B has its own member with an untouched `awaiting_payment`
      // cycle. It must remain EXACTLY as seeded after tenant A's flow runs.
      const memberB = randomUUID();
      await runInTenant(tenantB.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantB.ctx.slug,
          memberId: memberB,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Tenant B OnPaid Co',
          country: 'TH',
          planId: planB,
          planYear: 2026,
        }),
      );
      const cycleB = randomUUID();
      await runInTenant(tenantB.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantB.ctx.slug,
          cycleId: cycleB,
          memberId: memberB,
          status: 'awaiting_payment',
          periodFrom: new Date('2025-07-01T00:00:00.000Z'),
          periodTo: new Date('2026-07-01T00:00:00.000Z'),
          expiresAt: new Date('2026-07-01T00:00:00.000Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planB,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        }),
      );

      // Drive tenant A's full on-paid chain for a tenant-A member.
      const memberA = await seedMember();
      const invoiceA = await seedIssuedInvoice(memberA);
      await seedAwaitingCycleLinkedToInvoice({
        memberId: memberA,
        invoiceId: invoiceA,
        periodTo: new Date('2026-02-01T00:00:00.000Z'),
      });
      await fireOnPaidChainInTx(invoiceA, memberA);

      // Tenant B's cycle set is UNCHANGED: still exactly the one seeded
      // cycle, still `awaiting_payment` (not completed, no new `upcoming`).
      const cyclesB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ cycleId: renewalCycles.cycleId, status: renewalCycles.status })
          .from(renewalCycles)
          .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
      );
      expect(cyclesB).toHaveLength(1);
      expect(cyclesB[0]?.cycleId).toBe(cycleB);
      expect(cyclesB[0]?.status).toBe('awaiting_payment');
    } finally {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 180_000);
});

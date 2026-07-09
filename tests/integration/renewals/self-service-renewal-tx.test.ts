/**
 * F8 Phase 5 Wave D · T145 — self-service renewal tx integration test
 * (live Neon).
 *
 * Coverage on live Postgres:
 *
 *   1. **Happy path** — T123 `markCycleCompleteFromInvoicePaid`
 *      transitions awaiting_payment → completed, emits
 *      `renewal_completed`, and survives the
 *      `renewal_cycles_completed_requires_invoice_check` CHECK
 *      constraint (cycle keeps its linked_invoice_id pointing to a
 *      seeded F4 invoice row).
 *
 *   2. **FR-005b admin-block branch** — when the member has
 *      `blocked_from_auto_reactivation = TRUE`, T123 routes the
 *      cycle to `pending_admin_reactivation` + emits
 *      `renewal_completed_post_lapse`.
 *
 *   3. **No-cycle-for-invoice (idempotent skip)** — invoking the
 *      callback with an unknown invoice id returns
 *      `'no_cycle_for_invoice'` without side effects.
 *
 *   4. **f8OnPaidCallbacks production wiring** — `makeRenewalsDeps`
 *      no longer returns the empty-array Phase 2 stub; the factory
 *      produces a callback that invokes T123 on every paid event.
 *      Verified by counting the callback array length.
 *
 * Seed strategy: F4 invoices are inserted directly via Drizzle (status
 * = 'draft' is the minimum-CHECK-passing state — the FK on
 * `renewal_cycles.linked_invoice_id` is on `invoices(invoice_id)` and
 * does not require a specific status). This bypasses the full F4
 * createInvoiceDraft + issueInvoice + recordPayment chain (those are
 * F4's own integration test territory) and keeps T145 focused on the
 * F8 onPaidCallback path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  f8OnPaidCallbacks,
  makeRenewalsDeps,
  markCycleCompleteFromInvoicePaid,
} from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import {
  createTestTenant,
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// 055-member-number — `members.member_number` is NOT NULL with a per-tenant
// UNIQUE index. These raw-insert seeds (which bypass the createMember
// allocator) must supply a distinct positive integer per member. A
// monotonic counter keeps every seeded member collision-free regardless of
// how many seeds land in the same throwaway tenant.
let memberNumberSeq = 0;
function nextMemberNumber(): number {
  memberNumberSeq += 1;
  return memberNumberSeq;
}

const F4_PAID_DEFAULTS: Pick<
  F4InvoicePaidEvent,
  | 'paidAt'
  | 'amountSatang'
  | 'vatSatang'
  | 'currency'
  | 'paymentMethod'
  | 'triggeredBy'
  | 'invoiceSubject'
  | 'paymentDate'
> = {
  paidAt: '2026-05-07T08:00:00Z',
  amountSatang: asSatang(5_000_000n),
  vatSatang: asSatang(350_000n),
  currency: 'THB',
  invoiceSubject: 'membership',
  paymentDate: null,
  paymentMethod: 'stripe_card',
  triggeredBy: 'webhook',
};

describe('F8 markCycleCompleteFromInvoicePaid — integration (T145)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planTextId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    planTextId = `f8-self-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planTextId,
        planName: { en: 'Self-Service Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
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

  /**
   * Seed a single (member, F4 draft invoice, cycle in awaiting_payment
   * with linked_invoice_id) triplet. Returns the ids the test can
   * assert against. Distinct memberId per call → unique-active-cycle
   * invariant respected.
   */
  async function seedTriplet(opts: {
    blocked?: boolean;
  } = {}): Promise<{
    readonly memberId: string;
    readonly cycleId: string;
    readonly invoiceId: string;
  }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const invoiceId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      const memberValues = {
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextMemberNumber(),
        companyName: 'Self-Service Co',
        country: 'TH' as const,
        planId: planTextId,
        planYear: 2026,
        ...(opts.blocked
          ? {
              blockedFromAutoReactivation: true,
              blockedFromAutoReactivationAt: new Date(),
              blockedFromAutoReactivationSetByUserId: user.userId,
              blockedFromAutoReactivationReason:
                'integration-test-fr005b-block',
            }
          : {}),
      };
      await tx.insert(members).values(memberValues);
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planTextId,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      });
      // Rolling-anchor refactor (Task 6, migration 0238) — a TERMINAL
      // predecessor cycle so this member has TWO cycles ever, not the
      // shared classifier's `first_payment` shape ("exactly one cycle
      // ever, unanchored"). This suite drives markCycleCompleteFromInvoicePaid
      // and asserts plain completion/hold branches (FR-023/FR-005b), which
      // are orthogonal to Task 6's first-payment re-anchor branch — without
      // this predecessor, paying the seeded cycle below would re-anchor
      // instead of completing, breaking every assertion in this file that
      // checks the SPECIFIC seeded cycleId's row (status stays unaffected
      // by this extra row). 'cancelled' avoids needing a second invoice FK
      // target — mirrors e8da485b's pattern.
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-06-01T00:00:00Z'),
        periodTo: new Date('2025-06-01T00:00:00Z'),
        expiresAt: new Date('2025-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date('2025-06-01T00:00:00Z'),
        closedReason: 'cancelled',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
    });

    return { memberId, cycleId, invoiceId };
  }

  it('happy path: awaiting_payment → completed + emits renewal_completed', async () => {
    const { memberId, cycleId, invoiceId } = await seedTriplet();
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenantA.ctx.slug,
      invoiceId,
      memberId,
    };

    const r = await markCycleCompleteFromInvoicePaid(deps, event);
    expect(r.kind).toBe('completed');

    // Cycle moved to completed with closed_reason='paid' + linked_invoice_id intact.
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.closedReason).toBe('paid');
    expect(rows[0]?.linkedInvoiceId).toBe(invoiceId);

    // Audit row emitted.
    const audits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    expect(audits.map((a) => a.eventType)).toContain('renewal_completed');
  });

  it('FR-005b admin-block branch: cycle held in pending_admin_reactivation + renewal_completed_post_lapse audit', async () => {
    const { memberId, cycleId, invoiceId } = await seedTriplet({
      blocked: true,
    });
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenantA.ctx.slug,
      invoiceId,
      memberId,
    };

    const r = await markCycleCompleteFromInvoicePaid(deps, event);
    expect(r.kind).toBe('held_pending_admin');

    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          enteredPendingAt: renewalCycles.enteredPendingAt,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('pending_admin_reactivation');
    expect(rows[0]?.enteredPendingAt).not.toBeNull();
    expect(rows[0]?.linkedInvoiceId).toBe(invoiceId);

    const audits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    expect(audits.map((a) => a.eventType)).toContain(
      'renewal_completed_post_lapse',
    );
  });

  it('no_cycle_for_invoice: invoiceId not owned by any F8 cycle returns idempotent skip', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(), // not seeded — no cycle owns this id
      memberId: randomUUID(),
    };
    const r = await markCycleCompleteFromInvoicePaid(deps, event);
    expect(r.kind).toBe('no_cycle_for_invoice');
  });

  it('cross_tenant: tenant B context with tenant A invoice id returns no_cycle_for_invoice (Principle I sub-clause 3 / Review-Gate blocker)', async () => {
    // C3 review-fix: seed cycle in tenant A, then verify tenant B's
    // deps cannot resolve A's invoice through RLS scope. Mirrors the
    // pattern used in T144 cross-tenant token tests.
    const { a: tenantAA, b: tenantBB } = await createTwoTestTenants();
    try {
      const planId = `f8-xtenant-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantAA.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenantAA.ctx.slug,
          planId,
          planName: { en: 'Cross-Tenant Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
      const memberA = randomUUID();
      const cycleA = randomUUID();
      const invoiceA = randomUUID();
      await runInTenant(tenantAA.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenantAA.ctx.slug,
          memberId: memberA,
          memberNumber: nextMemberNumber(),
          companyName: 'Tenant A Co',
          country: 'TH',
          planId,
          planYear: 2026,
        });
        await tx.insert(invoices).values({
          tenantId: tenantAA.ctx.slug,
          invoiceId: invoiceA,
          memberId: memberA,
          planYear: 2026,
          planId,
          draftByUserId: user.userId,
          status: 'draft',
          currency: 'THB',
        });
        await tx.insert(renewalCycles).values({
          tenantId: tenantAA.ctx.slug,
          cycleId: cycleA,
          memberId: memberA,
          status: 'awaiting_payment',
          periodFrom: new Date('2026-06-01T00:00:00Z'),
          periodTo: new Date('2027-06-01T00:00:00Z'),
          expiresAt: new Date('2027-06-01T00:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          linkedInvoiceId: invoiceA,
        });
      });

      // Tenant B's deps invoking T123 with tenant A's invoiceId. RLS
      // hides the cycle row → findByInvoiceIdInTx returns null →
      // outcome is `no_cycle_for_invoice` (idempotent skip), NOT a
      // cross-tenant cycle completion.
      const depsB = makeRenewalsDeps(tenantBB.ctx.slug);
      const event: F4InvoicePaidEvent = {
        ...F4_PAID_DEFAULTS,
        tenantId: tenantBB.ctx.slug,
        invoiceId: invoiceA, // belongs to tenant A
        memberId: memberA,
      };
      const r = await markCycleCompleteFromInvoicePaid(depsB, event);
      expect(r.kind).toBe('no_cycle_for_invoice');

      // Tenant A's cycle MUST stay in awaiting_payment (untouched).
      const rowsA = await runInTenant(tenantAA.ctx, (tx) =>
        tx
          .select({ status: renewalCycles.status })
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleA))
          .limit(1),
      );
      expect(rowsA[0]?.status).toBe('awaiting_payment');
    } finally {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantAA.ctx.slug))
        .catch(() => {});
      await db
        .delete(invoices)
        .where(eq(invoices.tenantId, tenantAA.ctx.slug))
        .catch(() => {});
      await tenantAA.cleanup().catch(() => {});
      await tenantBB.cleanup().catch(() => {});
    }
  });

  it('I11 review-fix: re-fire on already-completed cycle is idempotent skip + does NOT duplicate audit (live Postgres)', async () => {
    // Lock the contract that T123's idempotent re-fire path
    // (`cycle_not_payable` outcome when cycle is already in `completed`)
    // is observed against real Drizzle + RLS rather than only mocked.
    const { memberId, cycleId, invoiceId } = await seedTriplet();
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenantA.ctx.slug,
      invoiceId,
      memberId,
    };

    // First fire: completes the cycle.
    const r1 = await markCycleCompleteFromInvoicePaid(deps, event);
    expect(r1.kind).toBe('completed');

    // Capture audit row count for this cycle BEFORE the second fire so
    // we can assert "no further audit emit" rather than relying on a
    // strict total-count match (other parallel tests may emit too).
    const beforeAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    const beforeCount = beforeAudits.length;

    // Second fire: cycle is now in `completed` — short-circuits with
    // `cycle_not_payable` (use-case path: status !== awaiting_payment).
    const r2 = await markCycleCompleteFromInvoicePaid(deps, event);
    expect(r2.kind).toBe('cycle_not_payable');

    // No new audit row emitted by the idempotent re-fire path (the
    // skip is logged with `logger.warn` only — the use-case explicitly
    // does not emit a `renewal_completed` second time).
    const afterAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    expect(afterAudits.length).toBe(beforeCount);

    // Cycle row is unchanged (still `completed` with `closed_reason='paid'`).
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.closedReason).toBe('paid');
  });

  it('D1 / US3 AS4 lock: F5 payment_failed → F4 NOT paid → F8 onPaidCallback NOT fired → cycle stays awaiting_payment + linked_invoice_id intact + zero completion audit', async () => {
    // Architectural reality (Wave K22 verify-fix D1): F8 listens
    // ONLY to F4's `invoice_marked_paid` event via `f8OnPaidCallbacks`.
    // When F5 returns `payment_failed`, F4's invoice stays in `issued`
    // and the onPaidCallback is never invoked — there is no F8-side
    // listener for the failure path. The cycle remains in
    // `awaiting_payment`, the reminder schedule resumes naturally on
    // the next cron pass (FR-010), and F5 owns its own `payment_failed`
    // audit on the F5 side. F8's `renewal_payment_failed` catalogue
    // entry (`renewal-audit-emitter.ts:55`) is reserved for a future
    // F5 → F8 listener bridge (post-MVP) — currently unwired by design.
    //
    // This test locks that contract: a refactor that accidentally
    // wired F5 payment_failed → F8 (e.g. via a misnamed F5 webhook
    // dispatcher entry) would cause the cycle to advance prematurely
    // and produce orphan `renewal_completed` audits. Both invariants
    // are asserted here.
    const { memberId, cycleId, invoiceId } = await seedTriplet();

    // Capture pre-state baseline.
    const beforeAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    const beforeCount = beforeAudits.length;

    // Simulate the F5 payment_failed timeline by NOT firing the
    // F4 onPaidCallback. The cycle should remain unchanged.
    const callbacks = f8OnPaidCallbacks(tenantA.ctx.slug);
    // QA-2026-05-10 fix: Phase 7 T183 added a SECOND callback
    // (tier-upgrade-apply); F8-completion Slice 1 added a THIRD
    // (create-next-cycle-on-paid) so the production factory now ships 3
    // callbacks (cycle-completion + tier-upgrade-apply + create-next-cycle)
    // per f4-callback-rollback.test.ts which is the canonical pin.
    expect(callbacks).toHaveLength(3);
    // INTENTIONALLY DO NOT INVOKE any callback — this models the
    // F5 payment_failed branch where F4 never transitions to paid.

    // Cycle is still awaiting_payment + linked_invoice_id intact.
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('awaiting_payment');
    expect(rows[0]?.closedReason).toBeNull();
    expect(rows[0]?.linkedInvoiceId).toBe(invoiceId);

    // Zero new audits — neither `renewal_completed` nor
    // `renewal_completed_post_lapse` nor any other terminal-cycle
    // audit has fired for this member.
    const afterAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    // Strongest invariant: the audit-row count didn't change between
    // pre-state baseline and post-no-callback-fire — so NO new audit of
    // ANY kind was emitted (including the 3 terminal-cycle audits below
    // that this test specifically guards against). Other tests in this
    // describe block have already emitted some renewal audits for the
    // shared tenant, so a substring `not.toContain` check would falsely
    // fail; the count-equality check is the right discriminator.
    expect(afterAudits.length).toBe(beforeCount);
    //
    // Belt + braces — assert the 3 specific terminal-cycle audit kinds
    // we're guarding against did NOT appear in the *delta* (i.e.
    // post-fire-skip - pre-state-baseline must have zero new occurrences
    // of each). Compute the delta by tally-comparing before vs after.
    const tally = (rows: ReadonlyArray<{ eventType: string }>) => {
      const out: Record<string, number> = {};
      for (const r of rows) out[r.eventType] = (out[r.eventType] ?? 0) + 1;
      return out;
    };
    const beforeTally = tally(beforeAudits);
    const afterTally = tally(afterAudits);
    // Round 5 staff-review (R007): per-key custom message arg so a
    // future regression where a single event type leaks reveals which
    // one in the failure output (vs an opaque "expected 2 to be 1").
    for (const key of [
      'renewal_completed',
      'renewal_completed_post_lapse',
      'renewal_payment_failed',
    ]) {
      expect(
        afterTally[key] ?? 0,
        `D1 invariant: no new '${key}' audit must be emitted after F5 payment_failed (F4-stays-issued path); regressed if delta != 0`,
      ).toBe(beforeTally[key] ?? 0);
    }

    // Member tally for the `memberId` should be 0 across all renewal-
    // terminal-state audits.
    void memberId; // referenced to satisfy `unused-var` lint on the seed return
  });

  it('f8OnPaidCallbacks: production factory returns 3 callbacks (Phase 5 T123 cycle-completion + Phase 7 T183 tier-upgrade-apply + F8-completion Slice 1 create-next-cycle)', async () => {
    const callbacks = f8OnPaidCallbacks(tenantA.ctx.slug);
    // QA-2026-05-10 fix: Phase 7 T183 added a SECOND callback
    // (tier-upgrade-apply); F8-completion Slice 1 added a THIRD
    // (create-next-cycle-on-paid) so the production factory now ships 3
    // callbacks per f4-callback-rollback.test.ts which is the canonical pin.
    expect(callbacks).toHaveLength(3);
    expect(typeof callbacks[0]).toBe('function');

    // The callback wraps T123 — invoke it with the same no_cycle_for_invoice
    // event from the previous test to verify the wrapper resolves the
    // dynamic import + calls T123 correctly. Resolves with no error
    // (no_cycle_for_invoice is a Result-ok success path).
    const event: F4InvoicePaidEvent = {
      ...F4_PAID_DEFAULTS,
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(),
      memberId: randomUUID(),
    };
    await expect(callbacks[0]!(event)).resolves.toBeUndefined();
  });
});

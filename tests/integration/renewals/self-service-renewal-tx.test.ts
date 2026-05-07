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

const F4_PAID_DEFAULTS: Pick<
  F4InvoicePaidEvent,
  | 'paidAt'
  | 'amountSatang'
  | 'vatSatang'
  | 'currency'
  | 'paymentMethod'
  | 'triggeredBy'
> = {
  paidAt: '2026-05-07T08:00:00Z',
  amountSatang: 5_000_000n,
  vatSatang: 350_000n,
  currency: 'THB',
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

  it('f8OnPaidCallbacks: production factory returns 1 callback (Phase 5 wired, was [] stub)', async () => {
    const callbacks = f8OnPaidCallbacks(tenantA.ctx.slug);
    expect(callbacks).toHaveLength(1);
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

/**
 * F8-completion Slice 0 · Task 0.3 (G5b) — HARD GATE: `transitionStatus`
 * now enforces `assertCanTransition` (domain edge check) BEFORE the
 * optimistic CAS (`WHERE status = from`). Live Neon.
 *
 * Two-part proof:
 *
 *  1. EVERY real cycle edge a live writer produces MUST pass through the
 *     now-enforcing `transitionStatus` WITHOUT throwing
 *     `InvalidCycleTransitionError`. These edges are DERIVED by driving
 *     each real use-case and observing the state it lands in — NOT a
 *     re-typed literal of the `TRANSITIONS` map (a re-typed list would
 *     pass even if the map and the live writers had diverged). If an edge
 *     were missing from the map, the use-case would throw and the cycle
 *     would never reach its target state — caught here.
 *
 *       - awaiting_payment → completed   (markPaidOffline, mocked F4 bridge)
 *       - upcoming         → completed   (markPaidOffline of an `upcoming`
 *                                         cycle — PAYABLE_STATUSES includes
 *                                         `upcoming`; the G5a edge)
 *       - awaiting_payment → cancelled   (cancelCycle)
 *       - upcoming         → cancelled   (cancelCycle)
 *       - awaiting_payment → lapsed      (lapseCyclesOnGraceExpiry cron)
 *       - pending_admin_reactivation → lapsed (reconcilePendingReactivations
 *                                         timeout — the G5a edge)
 *       - upcoming → awaiting_payment    (enter-awaiting — a Slice-2 writer
 *                                         not yet built; seeded/driven
 *                                         directly through transitionStatus
 *                                         here to prove the edge is enforced
 *                                         + declared ahead of Slice 2)
 *
 *  2. An ILLEGAL edge (`completed → upcoming`) throws
 *     `InvalidCycleTransitionError` BEFORE the CAS (today, with no
 *     enforcement, it would instead fall through to the CAS + probe and
 *     throw `CycleTransitionConflictError`/`CycleNotFoundError`).
 *
 *  Plus the domain control `canTransition('lapsed','cancelled') === false`
 *  — cancel-of-lapsed is rejected by the domain ahead of any repo call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import {
  cancelCycle,
  markPaidOffline,
  lapseCyclesOnGraceExpiry,
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { f5RefundBridge } from '@/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle';
import {
  InvalidCycleTransitionError,
  canTransition,
} from '@/modules/renewals/domain/value-objects/cycle-status';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 transitionStatus enforcement — integration (Task 0.3 / G5b)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  /**
   * Seed one member + one renewal cycle in the given NON-terminal status
   * (terminal `completed` requires a linked-invoice FK + CHECK, seeded
   * inline by the illegal-edge test).
   */
  async function seedMemberCycle(opts: {
    readonly status:
      | 'upcoming'
      | 'awaiting_payment'
      | 'pending_admin_reactivation';
    readonly expiresAt?: Date;
    readonly enteredPendingAt?: Date;
  }): Promise<{ memberId: string; cycleId: string }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60 * MS_PER_DAY);
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Edge Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: opts.status,
        periodFrom: new Date(expiresAt.getTime() - 365 * MS_PER_DAY),
        periodTo: expiresAt,
        expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        ...(opts.enteredPendingAt ? { enteredPendingAt: opts.enteredPendingAt } : {}),
      }),
    );
    return { memberId, cycleId };
  }

  /**
   * Mock the F4 bridge `issueAndMarkPaid` to fire `onPaid` against a
   * pre-seeded `issued` invoice (so the linked-invoice FK resolves when
   * the cycle flips to `completed`). Mirrors mark-paid-offline.test.ts.
   */
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
        proRatePolicySnapshot: 'whole_year',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Edge Co',
          country: 'TH',
          legal_name: 'Edge Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'edge@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  async function driveMarkPaidOfflineToCompleted(
    cycleId: string,
    memberId: string,
  ): Promise<'completed' | string> {
    const invoiceId = await seedIssuedInvoice(memberId);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const paidAt = new Date().toISOString();
    const spy = vi
      .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
      .mockImplementation(async (input) => {
        if (input.onPaid) {
          await input.onPaid({
            tenantId: input.tenantId,
            invoiceId,
            memberId: input.memberId,
            paidAt,
            amountSatang: asSatang(5_000_000n),
            vatSatang: asSatang(350_000n),
            currency: 'THB',
            paymentMethod: input.paymentMethod,
            triggeredBy: 'admin_offline_mark',
          });
        }
        return { ok: true, value: { invoiceId, paidAt } };
      });
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: `BT-${randomUUID().slice(0, 8)}`,
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    spy.mockRestore();
    if (!r.ok) return `markPaidOffline failed: ${r.error.kind}`;
    return r.value.cycleStatus;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-edge-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Edge Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenant.ctx.slug,
          gracePeriodDays: 14,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
        })
        .onConflictDoNothing(),
    );
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('awaiting_payment → completed passes through transitionStatus (markPaidOffline)', async () => {
    const { memberId, cycleId } = await seedMemberCycle({ status: 'awaiting_payment' });
    const out = await driveMarkPaidOfflineToCompleted(cycleId, memberId);
    expect(out).toBe('completed');
  });

  it('upcoming → completed passes through transitionStatus (markPaidOffline of upcoming — G5a edge)', async () => {
    const { memberId, cycleId } = await seedMemberCycle({ status: 'upcoming' });
    const out = await driveMarkPaidOfflineToCompleted(cycleId, memberId);
    expect(out).toBe('completed');
  });

  it('awaiting_payment → cancelled passes through transitionStatus (cancelCycle)', async () => {
    const { cycleId } = await seedMemberCycle({ status: 'awaiting_payment' });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      reason: 'edge proof awaiting→cancelled',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('cancelled');
  });

  it('upcoming → cancelled passes through transitionStatus (cancelCycle)', async () => {
    const { cycleId } = await seedMemberCycle({ status: 'upcoming' });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await cancelCycle(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      reason: 'edge proof upcoming→cancelled',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('cancelled');
  });

  it('awaiting_payment → lapsed passes through transitionStatus (lapseCyclesOnGraceExpiry)', async () => {
    // expires_at 40 days ago → past expiry + 14-day grace → lapses.
    const expiresAt = new Date(Date.now() - 40 * MS_PER_DAY);
    const { cycleId } = await seedMemberCycle({ status: 'awaiting_payment', expiresAt });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await lapseCyclesOnGraceExpiry(deps, {
      tenantId: tenant.ctx.slug,
      now: new Date(),
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.errors).toBe(0);
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('lapsed');
  });

  it('pending_admin_reactivation → lapsed passes through transitionStatus (reconcile-timeout — G5a edge)', async () => {
    // entered_pending_at 31 days ago → past the 30-day timeout → lapses.
    const enteredPendingAt = new Date(Date.now() - 31 * MS_PER_DAY);
    const { cycleId } = await seedMemberCycle({
      status: 'pending_admin_reactivation',
      enteredPendingAt,
    });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await reconcilePendingReactivations(
      { ...deps, f5RefundBridge },
      { tenantId: tenant.ctx.slug, now: new Date(), correlationId: randomUUID() },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timedOut).toBeGreaterThanOrEqual(1);
      expect(r.value.timeoutRefundFailures).toBe(0);
    }
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(rows[0]?.status).toBe('lapsed');
    expect(rows[0]?.closedReason).toBe('pending_reactivation_timed_out');
  });

  it('upcoming → awaiting_payment passes through transitionStatus (Slice-2 enter-awaiting; driven directly)', async () => {
    // enter-awaiting is a Slice-2 writer not yet built. Drive the edge
    // directly through the repo so it is enforced + declared ahead of
    // Slice 2 — must NOT throw InvalidCycleTransitionError.
    const { cycleId } = await seedMemberCycle({ status: 'upcoming' });
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const updated = await runInTenant(tenant.ctx, (tx) =>
      deps.cyclesRepo.transitionStatus(tx, tenant.ctx.slug, asCycleId(cycleId), {
        from: 'upcoming',
        to: 'awaiting_payment',
      }),
    );
    expect(updated.status).toBe('awaiting_payment');
  });

  it('an illegal edge (completed → upcoming) throws InvalidCycleTransitionError before the CAS', async () => {
    // A `completed` cycle requires linked_invoice_id NOT NULL
    // (renewal_cycles_completed_requires_invoice_check), and the invoice
    // carries a composite (tenant_id, member_id) FK to `members`. Seed
    // member → issued invoice (for that member) → completed cycle linked
    // to it, so all three FKs/CHECKs resolve.
    const memberId = randomUUID();
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Edge Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    const invoiceId = await seedIssuedInvoice(memberId);
    const expiresAt = new Date(Date.now() + 60 * MS_PER_DAY);
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'completed',
        periodFrom: new Date(expiresAt.getTime() - 365 * MS_PER_DAY),
        periodTo: expiresAt,
        expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date(),
        closedReason: 'paid',
        linkedInvoiceId: invoiceId,
      }),
    );
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        deps.cyclesRepo.transitionStatus(tx, tenant.ctx.slug, asCycleId(cycleId), {
          from: 'completed',
          to: 'upcoming',
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCycleTransitionError);
  });

  it('cancel-of-lapsed is rejected by the domain ahead of the repo call', () => {
    expect(canTransition('lapsed', 'cancelled')).toBe(false);
  });
});

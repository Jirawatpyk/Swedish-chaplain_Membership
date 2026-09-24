/**
 * `endMembershipCoverageNow` + `reconcileMembershipCoverageEnds` — the ONE
 * "end this member's coverage now" operation shared by the full manual
 * credit-note path and the full refund path (live Postgres).
 *
 * Root cause pinned first: paying a renewal bill moves its cycle
 * `awaiting_payment → completed` (terminal — `cancelCycle` refuses it with
 * `cycle_not_cancellable`) and opens the NEXT cycle at the old period end.
 * Access is derived from the member's latest cycle, and a plain `cancelled`
 * close honours paid-through access until `expires_at` — so neither the
 * "cancel it in Renewals" workaround nor the old F-2 cascade
 * (`cancelInFlightCyclesForMember`) ended a refunded member's coverage.
 *
 * Async refunds end coverage at SETTLEMENT, not at submit: a refund-backed
 * request only stamps a marker on the open cycle, and the nightly reconcile
 * ends coverage once the F5 refund settles `succeeded`. A refund that settles
 * `failed` returned no money, so the member keeps coverage and the request is
 * cleared. The reconcile reads the refund through the REAL F8→F5 bridge
 * (`getRefundOutcomeForInvoice` over seeded `payments` / `refunds` rows).
 *
 * Run in isolation:
 *   pnpm test:integration tests/integration/renewals/end-membership-coverage.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { asMemberId } from '@/modules/members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import {
  cancelCycle,
  cancelInFlightCyclesForMember,
  deriveMembershipAccess,
  endMembershipCoverageNow,
  makeRenewalsDeps,
  reconcileMembershipCoverageEnds,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const TOTAL = 107_000n;
// C1 = the period being served now; its renewal bill was paid, which
// completed C1 and opened C2 (the paid-for next period) at C1's end.
const C1_FROM = new Date('2025-10-01T00:00:00.000Z');
const C1_TO = new Date('2026-10-01T00:00:00.000Z');
const C2_TO = new Date('2027-10-01T00:00:00.000Z');

describe('end membership coverage now (shared by credit-note + refund paths)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'end-coverage-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await seedRenewalPolicies(tenant.ctx);
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'End Coverage Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(refunds).where(eq(refunds.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /**
   * A member who PAID their renewal: C1 `completed` (linked to the paid
   * renewal invoice), C2 `upcoming` — the paid-for next period, created after
   * C1 so it is the member's latest cycle.
   */
  async function seedPaidRenewal(): Promise<{
    memberId: string;
    c1: string;
    c2: string;
    invoiceId: string;
    paymentId: string;
  }> {
    const memberId = randomUUID();
    const c1 = randomUUID();
    const c2 = randomUUID();
    const invoiceId = randomUUID();
    const paymentId = `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'End Coverage Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 900_000) + 1,
        documentNumber: `EC-2026-${randomUUID().slice(0, 6)}`,
        issueDate: '2026-08-15',
        dueDate: '2026-09-14',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: TOTAL,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: {
          legal_name_th: 'ทดสอบ',
          legal_name_en: 'Test',
          tax_id: '0000000000000',
          address_th: 'Bangkok',
          address_en: 'Bangkok',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'End Coverage Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'n',
          primary_contact_email: 'test@example.com',
        },
        pdfBlobKey: 'invoicing/x/2026/seed.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'other',
        paymentReference: 'seed-ref',
        paymentNotes: null,
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-09-01',
        paidAt: new Date('2026-09-01T03:00:00Z'),
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: c1,
        memberId,
        status: 'completed',
        periodFrom: C1_FROM,
        periodTo: C1_TO,
        expiresAt: C1_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '1070.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
        closedAt: new Date('2026-09-01T03:00:00Z'),
        closedReason: 'paid',
        createdAt: new Date('2025-10-01T00:00:00Z'),
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: c2,
        memberId,
        status: 'upcoming',
        periodFrom: C1_TO,
        periodTo: C2_TO,
        expiresAt: C2_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '1070.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date('2026-09-01T03:00:01Z'),
      });
      const now = new Date('2026-09-01T03:00:00Z');
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'promptpay',
        status: 'succeeded',
        amountSatang: TOTAL,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        initiatedAt: now,
        completedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-end-coverage',
      });
    });
    return { memberId, c1, c2, invoiceId, paymentId };
  }

  /** Seed a still-`pending` async refund of the whole payment. */
  async function seedPendingRefund(invoiceId: string, paymentId: string): Promise<string> {
    const refundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(refunds).values({
        id: refundId,
        tenantId: tenant.ctx.slug,
        paymentId,
        invoiceId,
        amountSatang: TOTAL,
        reason: 'member withdrew',
        status: 'pending',
        processorRefundId: `re_test_${randomUUID().slice(0, 8)}`,
        initiatorUserId: user.userId,
        correlationId: 'corr-end-coverage-refund',
        initiatedAt: new Date(),
        membershipEffect: 'cancel_membership',
      });
    });
    return refundId;
  }

  async function settleRefund(refundId: string, outcome: 'succeeded' | 'failed') {
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(refunds)
        .set(
          outcome === 'failed'
            ? { status: 'failed', failureReasonCode: 'insufficient_funds', completedAt: new Date() }
            : // A waived settle keeps the fixture free of a real credit-note row;
              // the bridge treats it as a normal succeeded refund either way.
              {
                status: 'succeeded',
                completedAt: new Date(),
                creditNoteWaiverReason: 'invoice_voided',
                creditNoteWaivedAt: new Date(),
              },
        )
        .where(and(eq(refunds.tenantId, tenant.ctx.slug), eq(refunds.id, refundId))),
    );
  }

  async function access(memberId: string) {
    const latest = await makeRenewalsDeps(tenant.ctx.slug).cyclesRepo.findLatestCycleForMember(
      tenant.ctx.slug,
      memberId,
    );
    return deriveMembershipAccess(latest, new Date()).access;
  }

  async function cycleMember(cycleId: string) {
    const [row] = await db
      .select({ memberId: renewalCycles.memberId })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId));
    return row?.memberId;
  }

  async function cycleRow(cycleId: string) {
    const [row] = await db
      .select({
        status: renewalCycles.status,
        closedReason: renewalCycles.closedReason,
        endCoverageRequestedAt: renewalCycles.endCoverageRequestedAt,
        endCoverageRefundId: renewalCycles.endCoverageRefundId,
      })
      .from(renewalCycles)
      .where(and(eq(renewalCycles.tenantId, tenant.ctx.slug), eq(renewalCycles.cycleId, cycleId)));
    return row!;
  }

  const base = () => ({
    tenant: tenant.ctx,
    initiatedByUserId: user.userId,
    requestId: null,
  });

  it('root cause: the paid cycle cannot be cancelled, and cancelling the next cycle keeps the member Active', async () => {
    const { memberId, c1, c2 } = await seedPaidRenewal();
    expect(await access(memberId)).toBe('full');

    // "Cancel it in Renewals" on the paid (refunded) cycle is refused.
    const cancelPaid = await cancelCycle(makeRenewalsDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      cycleId: c1,
      reason: 'member refunded',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: 'corr-root-cause',
    });
    expect(cancelPaid.ok).toBe(false);
    if (!cancelPaid.ok) expect(cancelPaid.error.kind).toBe('cycle_not_cancellable');

    // The old F-2 cascade cancels the next cycle, but a plain `cancelled`
    // close honours paid-through access — the member is still Active.
    const cascade = await cancelInFlightCyclesForMember(makeRenewalsDeps(tenant.ctx.slug), {
      ...base(),
      memberId: asMemberId(memberId),
      correlationId: 'corr-root-cause-cascade',
    });
    expect(cascade.ok && cascade.value.cancelledCount).toBe(1);
    expect((await cycleRow(c2)).status).toBe('cancelled');
    expect(await access(memberId)).toBe('full');
  }, 60_000);

  it('ends coverage now: the open cycle closes `coverage_ended` and access is terminated immediately', async () => {
    const { memberId, c2 } = await seedPaidRenewal();
    const correlationId = `refund:${randomUUID()}`;

    const r = await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
      ...base(),
      memberId: asMemberId(memberId),
      trigger: 'refund',
      correlationId,
    });

    expect(r.ok && r.value).toEqual({ outcome: 'ended', cycleId: c2 });
    expect(await cycleRow(c2)).toMatchObject({ status: 'cancelled', closedReason: 'coverage_ended' });
    expect(await access(memberId)).toBe('terminated');

    const auditRows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_cancelled' as never),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.payload).toMatchObject({
      cycle_id: c2,
      member_id: memberId,
      reason: 'coverage_ended:refund',
      previous_status: 'upcoming',
    });
  }, 60_000);

  it('a member with no open cycle → no_open_cycle (nothing to end, nothing written)', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'No Cycle Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    const r = await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
      ...base(),
      memberId: asMemberId(memberId),
      trigger: 'credit_note',
      correlationId: `credit-note:${randomUUID()}`,
    });
    expect(r.ok && r.value).toEqual({ outcome: 'no_open_cycle' });
  }, 60_000);

  describe('async refund — coverage ends at SETTLEMENT, never at submit', () => {
    it('a PLAIN request already on the cycle → reports `scheduled` (not no_open_cycle) and keeps the plain one', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ endCoverageRequestedAt: new Date(), endCoverageActorUserId: user.userId })
          .where(eq(renewalCycles.cycleId, c2)),
      );
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      const r = await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'refund',
        awaitRefund: { refundId, invoiceId },
        correlationId: `refund:${refundId}`,
      });
      expect(r.ok && r.value).toEqual({ outcome: 'scheduled', cycleId: c2 });
      // The plain request (ends at the next pass) is never overwritten.
      expect(await cycleRow(c2)).toMatchObject({ status: 'upcoming', endCoverageRefundId: null });
    }, 60_000);

    it('a pending refund only schedules the end: the member stays Active until it settles', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);

      const r = await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'refund',
        awaitRefund: { refundId, invoiceId },
        correlationId: `refund:${refundId}`,
      });

      expect(r.ok && r.value).toEqual({ outcome: 'scheduled', cycleId: c2 });
      expect(await cycleRow(c2)).toMatchObject({ status: 'upcoming', endCoverageRefundId: refundId });
      expect(await access(memberId)).toBe('full');

      // Still pending at the hourly pass → nothing changes.
      await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), { tenant: tenant.ctx });
      expect(await cycleRow(c2)).toMatchObject({ status: 'upcoming', endCoverageRefundId: refundId });
      expect(await access(memberId)).toBe('full');
    }, 60_000);

    it('the refund FAILS after End membership was chosen → no money came back, so the member keeps coverage and the request is cleared', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'refund',
        awaitRefund: { refundId, invoiceId },
        correlationId: `refund:${refundId}`,
      });

      await settleRefund(refundId, 'failed');
      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });

      expect(pass.ok && pass.value.abandonedRefundFailed).toBeGreaterThanOrEqual(1);
      expect(await cycleRow(c2)).toMatchObject({
        status: 'upcoming',
        closedReason: null,
        endCoverageRequestedAt: null,
        endCoverageRefundId: null,
      });
      expect(await access(memberId)).toBe('full');
    }, 60_000);

    it('the refund SUCCEEDS → the nightly pass ends coverage (terminated)', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'refund',
        awaitRefund: { refundId, invoiceId },
        correlationId: `refund:${refundId}`,
      });

      await settleRefund(refundId, 'succeeded');
      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });

      expect(pass.ok && pass.value.ended).toBeGreaterThanOrEqual(1);
      expect(await cycleRow(c2)).toMatchObject({ status: 'cancelled', closedReason: 'coverage_ended' });
      expect(await access(memberId)).toBe('terminated');

      // Idempotent: the terminal row is not picked up again.
      const again = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });
      expect(again.ok).toBe(true);
      expect(await cycleRow(c2)).toMatchObject({ status: 'cancelled', closedReason: 'coverage_ended' });
    }, 60_000);
  });

  describe('reliability guards', () => {
    async function seedMemberWithCycle(
      status: 'pending_admin_reactivation' | 'lapsed' | 'upcoming',
    ): Promise<{ memberId: string; cycleId: string }> {
      const memberId = randomUUID();
      const cycleId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Guard Co',
          country: 'TH',
          planId,
          planYear: 2026,
        });
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId,
          memberId,
          status,
          periodFrom: C1_FROM,
          periodTo: C1_TO,
          expiresAt: C1_TO,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '1070.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          ...(status === 'pending_admin_reactivation' ? { enteredPendingAt: new Date() } : {}),
          ...(status === 'lapsed'
            ? { closedAt: new Date(), closedReason: 'lapsed' }
            : {}),
        });
      });
      return { memberId, cycleId };
    }

    it('never ends a pending_admin_reactivation cycle (its held payment belongs to the reactivation review)', async () => {
      const { memberId, cycleId } = await seedMemberWithCycle('pending_admin_reactivation');
      const r = await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'credit_note',
        correlationId: `credit-note:${randomUUID()}`,
      });
      expect(r.ok && r.value).toEqual({ outcome: 'no_open_cycle' });
      expect((await cycleRow(cycleId)).status).toBe('pending_admin_reactivation');
    }, 60_000);

    it('clears a request stranded on a cycle that left the open states (so a lapsed→comeback can never revive it) and counts it', async () => {
      const { cycleId } = await seedMemberWithCycle('lapsed');
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ endCoverageRequestedAt: new Date(), endCoverageActorUserId: user.userId })
          .where(eq(renewalCycles.cycleId, cycleId)),
      );
      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });
      expect(pass.ok && pass.value.strandedCleared).toBeGreaterThanOrEqual(1);
      expect(await cycleRow(cycleId)).toMatchObject({ status: 'lapsed', endCoverageRequestedAt: null });
    }, 60_000);

    it('expires a request whose refund has not settled in 14 days: cleared, counted, membership kept', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
        ...base(),
        memberId: asMemberId(memberId),
        trigger: 'refund',
        awaitRefund: { refundId, invoiceId },
        correlationId: `refund:${refundId}`,
      });
      // Realistic: the marker and its refund are both 15 days old (the
      // backstop window is shorter than the expiry, so it never re-stamps).
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000);
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(renewalCycles)
          .set({ endCoverageRequestedAt: fifteenDaysAgo })
          .where(eq(renewalCycles.cycleId, c2));
        await tx.update(refunds).set({ initiatedAt: fifteenDaysAgo }).where(eq(refunds.id, refundId));
      });
      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });
      expect(pass.ok && pass.value.expired).toBeGreaterThanOrEqual(1);
      expect(await cycleRow(c2)).toMatchObject({ status: 'upcoming', endCoverageRequestedAt: null });
      expect(await access(memberId)).toBe('full');
    }, 60_000);
  });

  describe('backstop — a lost route call never drops the staff decision', () => {
    it('refund SUCCEEDED with End chosen, but the route never ended coverage → the pass ends it', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId); // effect = cancel_membership
      await settleRefund(refundId, 'succeeded'); // no marker was ever stamped
      expect(await access(memberId)).toBe('full');

      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });
      expect(pass.ok && pass.value.backstopApplied).toBeGreaterThanOrEqual(1);
      expect(await cycleRow(c2)).toMatchObject({ status: 'cancelled', closedReason: 'coverage_ended' });
      expect(await access(memberId)).toBe('terminated');
    }, 60_000);

    it('refund still PENDING with End chosen and no request → the pass only stamps the request (membership kept for now)', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), { tenant: tenant.ctx });
      expect(await cycleRow(c2)).toMatchObject({ status: 'upcoming', endCoverageRefundId: refundId });
      expect(await access(memberId)).toBe('full');
    }, 60_000);

    it('refund with End chosen that settled FAILED, route call lost → the backstop does nothing (membership kept)', async () => {
      const { memberId, c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await settleRefund(refundId, 'failed');
      const pass = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), {
        tenant: tenant.ctx,
      });
      expect(pass.ok).toBe(true);
      expect(await cycleRow(c2)).toMatchObject({
        status: 'upcoming',
        endCoverageRequestedAt: null,
        endCoverageRefundId: null,
      });
      expect(await access(memberId)).toBe('full');
    }, 60_000);

    it('manual credit note with End chosen, route call lost → the pass ends coverage', async () => {
      const { memberId, c2, invoiceId } = await seedPaidRenewal();
      await runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          INSERT INTO credit_notes (
            tenant_id, credit_note_id, original_invoice_id, fiscal_year, sequence_number,
            document_number, issue_date, issued_by_user_id, reason, credit_amount_satang,
            vat_satang, total_satang, tenant_identity_snapshot, member_identity_snapshot,
            pdf_blob_key, pdf_sha256, pdf_template_version, membership_effect,
            created_at, updated_at
          ) VALUES (
            ${tenant.ctx.slug}, ${randomUUID()}, ${invoiceId}, 2026,
            ${Math.floor(Math.random() * 900_000) + 1}, ${'ECC-' + randomUUID().slice(0, 8)},
            '2026-09-10', ${user.userId}, 'withdrawal', 100000, 7000, 107000,
            '{}'::jsonb, '{}'::jsonb, 'k', ${'b'.repeat(64)}, 1, 'cancel_membership',
            NOW(), NOW()
          )
        `),
      );
      await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), { tenant: tenant.ctx });
      expect(await cycleRow(c2)).toMatchObject({ status: 'cancelled', closedReason: 'coverage_ended' });
      expect(await access(memberId)).toBe('terminated');
    }, 60_000);

    it('never touches an open cycle created AFTER the decision (e.g. a later comeback)', async () => {
      const { c2, invoiceId, paymentId } = await seedPaidRenewal();
      const refundId = await seedPendingRefund(invoiceId, paymentId);
      await settleRefund(refundId, 'succeeded');
      // The open cycle post-dates the refund decision.
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .update(renewalCycles)
          .set({ createdAt: new Date(Date.now() + 60_000) })
          .where(eq(renewalCycles.cycleId, c2)),
      );
      await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenant.ctx.slug), { tenant: tenant.ctx });
      expect((await cycleRow(c2)).status).toBe('upcoming');
    }, 60_000);
  });

  describe('tenant isolation (Principle I) — the request writes', () => {
    it("another tenant's repo can neither stamp nor clear this tenant's cycle", async () => {
      const other = await createTestTenant('test-chamber');
      try {
        const { c2, invoiceId, paymentId } = await seedPaidRenewal();
        const refundId = await seedPendingRefund(invoiceId, paymentId);
        await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
          ...base(),
          memberId: asMemberId((await cycleMember(c2))!),
          trigger: 'refund',
          awaitRefund: { refundId, invoiceId },
          correlationId: `refund:${refundId}`,
        });
        const otherRepo = makeRenewalsDeps(other.ctx.slug).coverageEndRequests;
        const stamped = await runInTenant(other.ctx, (tx) =>
          otherRepo.stampInTx(tx, other.ctx.slug, c2 as never, {
            requestedAt: new Date().toISOString(),
            refundId: null,
            invoiceId: null,
            actorUserId: null,
          }),
        );
        const cleared = await runInTenant(other.ctx, (tx) =>
          otherRepo.clearInTx(tx, other.ctx.slug, c2 as never, refundId),
        );
        expect(stamped).toBe(false);
        expect(cleared).toBe(false);
        expect(await cycleRow(c2)).toMatchObject({ endCoverageRefundId: refundId });
        const otherPending = await otherRepo.listPending(other.ctx.slug, 50);
        expect(otherPending.find((r) => r.cycleId === c2)).toBeUndefined();
      } finally {
        await other.cleanup().catch(() => {});
      }
    }, 60_000);

    it("another tenant's backstop readers and clearStranded neither see nor touch this tenant's rows", async () => {
      const other = await createTestTenant('test-chamber');
      try {
        const { c2, invoiceId, paymentId } = await seedPaidRenewal();
        // A refund with End chosen (durable source row) + its request on c2 …
        const refundId = await seedPendingRefund(invoiceId, paymentId);
        await endMembershipCoverageNow(makeRenewalsDeps(tenant.ctx.slug), {
          ...base(),
          memberId: asMemberId((await cycleMember(c2))!),
          trigger: 'refund',
          awaitRefund: { refundId, invoiceId },
          correlationId: `refund:${refundId}`,
        });
        // … and a manual credit note with End chosen on the same invoice.
        const creditNoteId = randomUUID();
        await runInTenant(tenant.ctx, (tx) =>
          tx.execute(sql`
            INSERT INTO credit_notes (
              tenant_id, credit_note_id, original_invoice_id, fiscal_year, sequence_number,
              document_number, issue_date, issued_by_user_id, reason, credit_amount_satang,
              vat_satang, total_satang, tenant_identity_snapshot, member_identity_snapshot,
              pdf_blob_key, pdf_sha256, pdf_template_version, membership_effect,
              created_at, updated_at
            ) VALUES (
              ${tenant.ctx.slug}, ${creditNoteId}, ${invoiceId}, 2026,
              ${Math.floor(Math.random() * 900_000) + 1}, ${'ECX-' + randomUUID().slice(0, 8)},
              '2026-09-10', ${user.userId}, 'withdrawal', 1, 0, 1,
              '{}'::jsonb, '{}'::jsonb, 'k', ${'c'.repeat(64)}, 1, 'cancel_membership',
              NOW(), NOW()
            )
          `),
        );
        // … then strand the request: an admin plain-cancels the cycle.
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(renewalCycles)
            .set({ status: 'cancelled', closedAt: new Date(), closedReason: 'cancelled' })
            .where(eq(renewalCycles.cycleId, c2)),
        );

        const otherDeps = makeRenewalsDeps(other.ctx.slug);
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const seenByOther = await otherDeps.membershipEndRequestSource.listSince(other.ctx.slug, since);
        expect(seenByOther.find((r) => r.kind === 'refund' && r.refundId === refundId)).toBeUndefined();
        expect(
          seenByOther.find((r) => r.kind === 'credit_note' && r.creditNoteId === creditNoteId),
        ).toBeUndefined();

        const clearedByOther = await otherDeps.coverageEndRequests.clearStranded(other.ctx.slug);
        expect(clearedByOther).not.toContain(c2);
        expect(await cycleRow(c2)).toMatchObject({ endCoverageRefundId: refundId });

        // Positive control: the owning tenant does see / clear them.
        const own = makeRenewalsDeps(tenant.ctx.slug);
        const seenByOwn = await own.membershipEndRequestSource.listSince(tenant.ctx.slug, since);
        expect(seenByOwn.find((r) => r.kind === 'refund' && r.refundId === refundId)).toBeDefined();
        expect(
          seenByOwn.find((r) => r.kind === 'credit_note' && r.creditNoteId === creditNoteId),
        ).toBeDefined();
        expect(await own.coverageEndRequests.clearStranded(tenant.ctx.slug)).toContain(c2);
      } finally {
        await other.cleanup().catch(() => {});
      }
    }, 60_000);
  });
});

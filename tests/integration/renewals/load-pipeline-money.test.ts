/**
 * DV-Wave2 ⑥ — `loadPipelineMoney` integration test (live Neon).
 *
 * Proves the CORRECTED money band (financial-reporting spec § 7), NOT the
 * brief's banned flow÷stock sketch. The seed exercises every leg the review
 * mandated:
 *   - FY-cohort collection rate (settled / (settled + overdue), this-FY, BKK)
 *   - credit netting (#5 partially_credited → 30000, not 40000)
 *   - §105 waived netting (#6 fully-waived paid → settled leg 0, not 25000)
 *   - collected-this-month scoping by paid_at (#4 May, #6 April excluded)
 *   - strict FY boundary (#7 prior-FY unpaid drops from BOTH rate legs)
 *   - void exclusion (#8)
 *   - cross-tenant isolation (tenant B's ฿0.11 never leaks into A)
 *   - month-boundary invariance (the rate is identical across a BKK month
 *     rollover — directly refutes the flow÷stock trap)
 *
 * Seeding: direct-insert full-snapshot invoice rows (the proven idiom from
 * `issue-membership-bill.test.ts` / `refund-vs-voided-invoice.test.ts`), which
 * satisfies `invoices_non_draft_has_snapshots`. The §105 waived refund is a
 * genuine (payment → succeeded waived refund) pair so the real F5
 * `sumWaivedByInvoice` read (via the renewals waived-refund adapter wired into
 * `makeRenewalsDeps`) picks it up.
 *
 * Run in isolation to avoid shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/renewals/load-pipeline-money.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { collectionRatePct, loadPipelineMoney, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

// Pinned instant: 2026-07-15 10:00 BKK. SweCham fiscalYearStartMonth = 1 →
// fyStart = 2026-01-01, today = 2026-07-15, monthStart = 2026-07-01,
// windowDays 90 → windowEnd = 2026-10-13.
const NOW = '2026-07-15T03:00:00.000Z';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Pipeline Money Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

interface SeedInvoiceSpec {
  readonly status: 'issued' | 'paid' | 'partially_credited' | 'credited' | 'void';
  readonly totalSatang: bigint;
  readonly creditedTotalSatang: bigint;
  /** YYYY-MM-DD (BKK calendar due date, F4 convention). */
  readonly dueDate: string;
  /** ISO UTC instant, or null for unpaid. */
  readonly paidAtIso: string | null;
  readonly seq: number;
}

async function seedMembershipInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  memberId: string,
  spec: SeedInvoiceSpec,
): Promise<string> {
  const invoiceId = randomUUID();
  const isVoid = spec.status === 'void';
  const hasPaidAt = spec.paidAtIso !== null;
  const subtotal = (spec.totalSatang * 100n) / 107n; // rough VAT-inclusive split
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: spec.status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: spec.seq,
      documentNumber: `SC-2026-${String(spec.seq).padStart(6, '0')}`,
      issueDate: spec.dueDate,
      dueDate: spec.dueDate,
      subtotalSatang: subtotal,
      vatRateSnapshot: '0.0700',
      vatSatang: spec.totalSatang - subtotal,
      totalSatang: spec.totalSatang,
      creditedTotalSatang: spec.creditedTotalSatang,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      // `invoices_paid_has_payment` / `invoices_paid_has_receipt_status`:
      // only `paid` REQUIRES these — but partially_credited/credited rows
      // are already-paid cash, so carry them for realism when paid_at is set.
      paymentMethod: hasPaidAt ? 'bank_transfer' : null,
      paymentReference: hasPaidAt ? 'seed-ref' : null,
      paymentRecordedByUserId: hasPaidAt ? user.userId : null,
      paidAt: spec.paidAtIso ? new Date(spec.paidAtIso) : null,
      receiptPdfStatus: hasPaidAt ? 'rendered' : null,
      // `invoices_void_has_reason`
      voidedAt: isVoid ? new Date('2026-06-02T00:00:00Z') : null,
      voidReason: isVoid ? 'seed void' : null,
      voidedByUserId: isVoid ? user.userId : null,
      autoEmailOnIssue: true,
    });
  });
  return invoiceId;
}

/**
 * Seed a §105 SUCCEEDED WAIVED refund on `invoiceId`, so the real F5
 * `sumWaivedByInvoice` read returns it. Satisfies `refunds_succeeded_iff_
 * documented` (processor_refund_id + credit_note_waived_at, credit_note_id
 * NULL per `refunds_cn_xor_waived`) + `refunds_completed_at_iff_not_pending`.
 */
async function seedWaivedRefund(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  invoiceId: string,
  amountSatang: bigint,
): Promise<void> {
  const paymentId = `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const at = new Date('2026-04-15T03:00:00Z');
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(payments).values({
      id: paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      method: 'card',
      status: 'succeeded',
      amountSatang,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 12,
      cardExpYear: 2030,
      initiatedAt: at,
      completedAt: at,
      actorUserId: user.userId,
      correlationId: `seed-pay-${invoiceId.slice(0, 8)}`,
    });
    await tx.insert(refunds).values({
      id: `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      tenantId: tenant.ctx.slug,
      paymentId,
      invoiceId,
      amountSatang,
      reason: 'section 105 receipt — full waiver',
      status: 'succeeded',
      processorRefundId: `re_test_${randomUUID().slice(0, 8)}`,
      creditNoteId: null,
      creditNoteWaiverReason: 'section_105_receipt',
      creditNoteWaivedAt: at,
      initiatedAt: at,
      completedAt: at,
      initiatorUserId: user.userId,
      correlationId: `seed-rfnd-${invoiceId.slice(0, 8)}`,
    });
  });
}

describe('DV-Wave2 ⑥ loadPipelineMoney — integration (live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a, b } = await createTwoTestTenants());

    // --- Tenant A: one plan + member, eight membership invoices ---
    const planA = `pm-plan-${randomUUID().slice(0, 8)}`;
    const memberA = randomUUID();
    await runInTenant(a.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: a.ctx.slug,
        planId: planA,
        planName: { en: 'Pipeline Money Plan A' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(a.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: a.ctx.slug,
        memberId: memberA,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Pipeline Money Co',
        country: 'TH',
        planId: planA,
        planYear: 2026,
      }),
    );

    // #1 dueSoon; #2 overdue; #3 settled+collected; #4 settled only (May);
    // #5 partially_credited settled(30000)+collected(30000); #6 §105-waived
    // settled(0); #7 prior-FY DROPS; #8 void excluded.
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'issued', totalSatang: 30000n, creditedTotalSatang: 0n, dueDate: '2026-08-01', paidAtIso: null, seq: 1,
    });
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'issued', totalSatang: 50000n, creditedTotalSatang: 0n, dueDate: '2026-06-10', paidAtIso: null, seq: 2,
    });
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'paid', totalSatang: 70000n, creditedTotalSatang: 0n, dueDate: '2026-05-01', paidAtIso: '2026-07-05T03:00:00Z', seq: 3,
    });
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'paid', totalSatang: 90000n, creditedTotalSatang: 0n, dueDate: '2026-02-01', paidAtIso: '2026-05-20T03:00:00Z', seq: 4,
    });
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'partially_credited', totalSatang: 40000n, creditedTotalSatang: 10000n, dueDate: '2026-03-01', paidAtIso: '2026-07-10T03:00:00Z', seq: 5,
    });
    const inv6 = await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'paid', totalSatang: 25000n, creditedTotalSatang: 0n, dueDate: '2026-04-01', paidAtIso: '2026-04-15T03:00:00Z', seq: 6,
    });
    await seedWaivedRefund(a, user, memberA, inv6, 25000n);
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'issued', totalSatang: 88000n, creditedTotalSatang: 0n, dueDate: '2025-11-01', paidAtIso: null, seq: 7,
    });
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'void', totalSatang: 99999n, creditedTotalSatang: 0n, dueDate: '2026-06-01', paidAtIso: '2026-06-02T03:00:00Z', seq: 8,
    });

    // --- Tenant B: cross-tenant leak guard — one issued invoice, ฿0.11 ---
    const planB = `pm-plan-${randomUUID().slice(0, 8)}`;
    const memberB = randomUUID();
    await runInTenant(b.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: b.ctx.slug,
        planId: planB,
        planName: { en: 'Pipeline Money Plan B' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(b.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: b.ctx.slug,
        memberId: memberB,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Leak Guard Co',
        country: 'TH',
        planId: planB,
        planYear: 2026,
      }),
    );
    await seedMembershipInvoice(b, user, planB, memberB, {
      status: 'issued', totalSatang: 11n, creditedTotalSatang: 0n, dueDate: '2026-08-01', paidAtIso: null, seq: 1,
    });
  }, 120_000);

  afterAll(async () => {
    for (const t of [a, b]) {
      if (!t) continue;
      await db.delete(refunds).where(eq(refunds.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(payments).where(eq(payments.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)).catch(() => {});
    }
    await a?.cleanup().catch(() => {});
    await b?.cleanup().catch(() => {});
  }, 120_000);

  it('nets credit + §105 waived per-invoice; FY-cohort rate = 79.2%', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      nowIso: NOW,
      windowDays: 90,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // settled = 70000 + 90000 + (40000−10000) + (25000−25000 waived) = 190000
    expect(res.value.settledDueToDateSatang).toBe(190000n);
    // overdue = #2 only; #7 prior-FY excluded, #8 void excluded
    expect(res.value.overdueSatang).toBe(50000n);
    // collected (July) = #3 (70000) + #5 net (30000); #4 May, #6 April excluded
    expect(res.value.collectedThisPeriodSatang).toBe(100000n);
    // dueSoon = #1 only
    expect(res.value.dueSoonSatang).toBe(30000n);

    // rate = 190000·10000 / 240000 = 7916 → 79.16 → "79.2%"
    const rate = collectionRatePct(
      res.value.settledDueToDateSatang,
      res.value.overdueSatang,
    );
    expect(rate).not.toBeNull();
    expect(rate?.toFixed(1)).toBe('79.2');
  }, 60_000);

  it('cross-tenant: B money never appears in A sums, and B reads only its own', async () => {
    const forA = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      nowIso: NOW,
      windowDays: 90,
    });
    if (!forA.ok) throw new Error('expected ok for A');
    // Not 50011n — B's ฿0.11 due-2026-08-01 issued invoice must not leak.
    expect(forA.value.overdueSatang).toBe(50000n);
    expect(forA.value.dueSoonSatang).toBe(30000n); // #1 only, not #1 + B's 11

    const forB = await loadPipelineMoney(makeRenewalsDeps(b.ctx.slug), {
      tenantId: b.ctx.slug,
      nowIso: NOW,
      windowDays: 90,
    });
    if (!forB.ok) throw new Error('expected ok for B');
    // B sees only its own single issued invoice (due 2026-08-01 → dueSoon).
    expect(forB.value.dueSoonSatang).toBe(11n);
    expect(forB.value.overdueSatang).toBe(0n);
    expect(forB.value.settledDueToDateSatang).toBe(0n);
    expect(forB.value.collectedThisPeriodSatang).toBe(0n);
  }, 60_000);

  it('rate is invariant across a BKK month rollover (refutes flow÷stock)', async () => {
    // Both instants sit inside FY2026 and no due_date lands on the boundary,
    // so the DUE-COHORT rate must be identical. The banned flow÷stock rate
    // would jump because "collected this month" resets on Aug 1.
    const july31 = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      nowIso: '2026-07-31T03:00:00.000Z',
      windowDays: 90,
    });
    const aug1 = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      nowIso: '2026-08-01T03:00:00.000Z',
      windowDays: 90,
    });
    if (!july31.ok || !aug1.ok) throw new Error('expected ok for both instants');

    const rateJul = collectionRatePct(
      july31.value.settledDueToDateSatang,
      july31.value.overdueSatang,
    );
    const rateAug = collectionRatePct(
      aug1.value.settledDueToDateSatang,
      aug1.value.overdueSatang,
    );
    expect(rateJul).toBe(rateAug);

    // The collected leg DOES move across the rollover — exactly why it is NOT
    // in the rate: July has #3 + #5 (100000), August has none.
    expect(july31.value.collectedThisPeriodSatang).toBe(100000n);
    expect(aug1.value.collectedThisPeriodSatang).toBe(0n);
  }, 60_000);
});

/**
 * Fix round 1 #3 — `admin/renewals` page.tsx now resolves the tenant's REAL
 * `fiscalYearStartMonth` (via `deps.fiscalYearSettings`) instead of silently
 * defaulting to January. This proves `loadPipelineMoney`'s SQL cohort
 * boundary actually MOVES when a non-default value is passed through — the
 * invariant that fix depends on — guarding against a regression where the
 * param is silently ignored or the default re-creeps in.
 *
 * A single issued (unpaid) invoice due 2026-02-15 sits inside FY2026 under a
 * January-start fiscal year, but inside the PRIOR fiscal year (Apr2025–
 * Mar2026) under an April-start one — same row, same `nowIso`, different
 * cohort membership depending solely on `fiscalYearStartMonth`.
 */
describe('DV-Wave2 ⑥ / Fix round 1 #3 — fiscalYearStartMonth shifts the due-cohort boundary', () => {
  let fy: TestTenant;
  let fyUser: TestUser;

  // "today" = 2026-07-15 BKK — same pinned instant as the suite above (month
  // 7 sits after both candidate fiscal-year-start months, so `fyStart` for
  // fiscalYearStartMonth=4 lands on 2026-04-01, not 2025-04-01).
  const FY_NOW = '2026-07-15T03:00:00.000Z';

  beforeAll(async () => {
    fyUser = await createActiveTestUser('admin');
    fy = await createTestTenant('test-swecham');

    const planId = `pm-plan-${randomUUID().slice(0, 8)}`;
    const memberId = randomUUID();
    await runInTenant(fy.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: fy.ctx.slug,
        planId,
        planName: { en: 'FY Boundary Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: fyUser.userId,
      }),
    );
    await runInTenant(fy.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: fy.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'FY Boundary Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    await seedMembershipInvoice(fy, fyUser, planId, memberId, {
      status: 'issued',
      totalSatang: 1234500n,
      creditedTotalSatang: 0n,
      dueDate: '2026-02-15',
      paidAtIso: null,
      seq: 1,
    });
  }, 120_000);

  afterAll(async () => {
    if (fy) {
      await db.delete(invoices).where(eq(invoices.tenantId, fy.ctx.slug)).catch(() => {});
    }
    await fy?.cleanup().catch(() => {});
  }, 120_000);

  it('counts the Feb-due invoice as overdue under a January fiscal year', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(fy.ctx.slug), {
      tenantId: fy.ctx.slug,
      nowIso: FY_NOW,
      windowDays: 90,
      fiscalYearStartMonth: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.overdueSatang).toBe(1234500n);
  }, 60_000);

  it('drops the SAME Feb-due invoice from the cohort under an April fiscal year (prior-FY)', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(fy.ctx.slug), {
      tenantId: fy.ctx.slug,
      nowIso: FY_NOW,
      windowDays: 90,
      fiscalYearStartMonth: 4,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.overdueSatang).toBe(0n);
  }, 60_000);
});

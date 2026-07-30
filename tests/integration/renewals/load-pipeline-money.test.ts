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
 * Fix round 2 #10 adds two more regression guards to the SAME tenant-A seed:
 *   - #9 an `invoice_subject='event'` PAID invoice (dueDate + paidAt chosen
 *     to land squarely inside BOTH the settled-FY window and the July
 *     collected window) proves the repo's `invoice_subject = 'membership'`
 *     predicate — if it were ever dropped, this row would silently inflate
 *     BOTH `settledDueToDateSatang` and `collectedThisPeriodSatang`.
 *   - a §105 waived refund on invoice #1 (the due-soon, unpaid, OUTSIDE the
 *     settled/collected cohort) proves the per-invoice waived intersection in
 *     `netLeg` (`load-pipeline-money.ts`) — if a future change summed the
 *     WHOLE tenant-wide waived map instead of per-row, this waiver would
 *     wrongly bleed into `settledDueToDateSatang` even though invoice #1 was
 *     never a settled row.
 * Both guards assert the SAME sums as the first test below — unchanged by
 * either addition when the code is correct.
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
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
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
// #10 fix round 2 — buyer snapshot for the non-membership (event) invoice;
// event invoices have no `member_id` so they carry a walk-in buyer snapshot
// instead of `SNAP_MEMBER` (mirrors `invoice-subject-filter.test.ts`).
const SNAP_BUYER = {
  legal_name: 'Walk-in Guest Ltd',
  tax_id: null,
  address: 'Bangkok',
  primary_contact_name: 'Guest',
  primary_contact_email: 'guest@example.com',
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
 * #10 fix round 2 — seed a PAID `invoice_subject='event'` invoice, to prove
 * the repo's `invoice_subject = 'membership'` predicate excludes it from
 * every leg. `dueDate` sits inside the FY2026-before-today window
 * (settledRows' predicate) and `paidAtIso` sits inside July BKK (collected
 * window) — chosen so that IF the subject predicate were ever dropped, this
 * row would inflate BOTH `settledDueToDateSatang` and
 * `collectedThisPeriodSatang` by a nonzero, easily-noticed amount.
 *
 * Needs a real `events` + `event_registrations` row for the composite FK
 * (`invoices_subject_fields_ck` requires `event_id` + `event_registration_id`
 * for the event subject) — same shape as
 * `tests/integration/invoicing/invoice-subject-filter.test.ts`.
 */
async function seedEventInvoice(
  tenant: TestTenant,
  user: TestUser,
  spec: { readonly dueDate: string; readonly paidAtIso: string; readonly totalSatang: bigint; readonly seq: number },
): Promise<string> {
  const invoiceId = randomUUID();
  const eventId = randomUUID();
  const regId = randomUUID();
  const vat = (spec.totalSatang * 7n) / 107n;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt_money_band_${invoiceId.slice(0, 8)}`,
      name: 'Money Band Subject-Filter Gala',
      startDate: new Date('2026-09-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId: regId,
      eventId,
      externalId: `att_money_band_${invoiceId.slice(0, 8)}`,
      attendeeEmail: 'walkin@example.com',
      attendeeName: 'Walk-in Guest',
      attendeeCompany: 'Walk-in Guest Ltd',
      matchType: 'non_member',
      ticketType: 'General',
      ticketPriceThb: Number(spec.totalSatang / 100n),
      paymentStatus: 'paid',
      registeredAt: new Date(spec.paidAtIso),
    } satisfies NewEventRegistrationRow);
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      invoiceSubject: 'event',
      eventId,
      eventRegistrationId: regId,
      vatInclusive: true,
      memberId: null,
      planId: null,
      planYear: null,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: spec.seq,
      documentNumber: `SC-2026-${String(spec.seq).padStart(6, '0')}`,
      issueDate: spec.dueDate,
      dueDate: spec.dueDate,
      subtotalSatang: spec.totalSatang - vat,
      vatRateSnapshot: '0.0700',
      vatSatang: vat,
      totalSatang: spec.totalSatang,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: null,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_BUYER,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'c'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref-event',
      paymentRecordedByUserId: user.userId,
      paidAt: new Date(spec.paidAtIso),
      receiptPdfStatus: 'rendered',
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
    // settled(0); #7 prior-FY DROPS from the FY legs but now LANDS in the
    // overdueBeforeFy pair (renewals-overdue-prior-fy-subline); #8 void
    // excluded; #9 event-subject PAID (fix round 2 #10a, below) DROPS
    // despite landing inside both windows; a §105-waived refund on #1 (fix
    // round 2 #10b, below) proves waived netting never leaks outside the
    // settled/collected cohort; #11 (seq 10) a SECOND prior-FY issued bill
    // due 2024-12-15 proves the overdueBeforeFy pair aggregates across
    // MULTIPLE prior years (no lower date bound) and that COUNT counts rows,
    // not years.
    const inv1 = await seedMembershipInvoice(a, user, planA, memberA, {
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
    // #11 (renewals-overdue-prior-fy-subline) — second prior-FY issued bill,
    // TWO fiscal years back: overdueBeforeFy = #7 (88000) + #11 (12000).
    await seedMembershipInvoice(a, user, planA, memberA, {
      status: 'issued', totalSatang: 12000n, creditedTotalSatang: 0n, dueDate: '2024-12-15', paidAtIso: null, seq: 10,
    });

    // #10 fix round 2 (a) — event-subject PAID invoice; due 2026-05-10 (FY,
    // before "today") + paid 2026-07-18 (July) so it would inflate BOTH
    // settled AND collected if `invoice_subject = 'membership'` were ever
    // dropped from the repo's `membership` predicate.
    await seedEventInvoice(a, user, {
      dueDate: '2026-05-10', paidAtIso: '2026-07-18T03:00:00Z', totalSatang: 214000n, seq: 9,
    });
    // #10 fix round 2 (b) — §105 waived refund on #1 (due-soon, UNPAID,
    // OUTSIDE the settled/collected cohort). `netLeg` (load-pipeline-money.ts)
    // must intersect the waived map PER-ROW against settledRows/collectedRows
    // only; #1 never appears in either list, so this waiver must NOT reduce
    // settledDueToDateSatang (guards against a future "sum the whole
    // tenant-wide waived map" regression).
    await seedWaivedRefund(a, user, memberA, inv1, 10000n);

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
    // — UNCHANGED by #9 (event-subject, excluded by invoice_subject filter)
    // and by #1's waived refund (outside this cohort, never intersected).
    expect(res.value.settledDueToDateSatang).toBe(190000n);
    // overdue = #2 only; #7 + #11 prior-FY excluded, #8 void excluded
    expect(res.value.overdueSatang).toBe(50000n);
    // renewals-overdue-prior-fy-subline — #7 (88000, due 2025-11-01) + #11
    // (12000, due 2024-12-15) land in the prior-FY pair instead of silently
    // vanishing; NOT double-counted in the FY overdue leg above.
    expect(res.value.overdueBeforeFySatang).toBe(100000n);
    expect(res.value.overdueBeforeFyCount).toBe(2);
    // Task 3 (renewals-suspended-visibility-audit) — the SQL leg's own FY
    // boundary surfaces for the band's `?dueBefore=` drill-down.
    expect(res.value.fyStartDate).toBe('2026-01-01');
    // collected (July) = #3 (70000) + #5 net (30000); #4 May, #6 April
    // excluded — UNCHANGED by #9 despite #9 also being paid in July.
    expect(res.value.collectedThisPeriodSatang).toBe(100000n);
    // dueSoon = #1 only, at its FULL 30000 (§105-waived refunds are never
    // netted against the scalar dueSoon/overdue legs — only settled/collected
    // go through `netLeg`).
    expect(res.value.dueSoonSatang).toBe(30000n);

    // rate = 190000·10000 / 240000 = 7916 → 79.16 → "79.2%"
    const rate = collectionRatePct(
      res.value.settledDueToDateSatang,
      res.value.overdueSatang,
    );
    expect(rate).not.toBeNull();
    expect(rate?.toFixed(1)).toBe('79.2');
  }, 60_000);

  it('#10 fix round 2 — event-subject invoice excluded from every leg, and its neighbour\'s waived refund never leaks into a membership leg', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(a.ctx.slug), {
      tenantId: a.ctx.slug,
      nowIso: NOW,
      windowDays: 90,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Same four sums as the test above — restated here as an explicit,
    // independently-named regression guard for the #10(a)/(b) seed rows (an
    // event-subject PAID invoice due 2026-05-10/paid 2026-07-18, and a §105
    // waived refund on the due-soon invoice #1). If `invoice_subject =
    // 'membership'` were dropped from the repo's `membership` predicate, OR
    // `netLeg` summed the WHOLE tenant-wide waived map instead of
    // intersecting it per-row against settledRows/collectedRows, these sums
    // would move.
    expect(res.value.settledDueToDateSatang).toBe(190000n);
    expect(res.value.overdueSatang).toBe(50000n);
    expect(res.value.collectedThisPeriodSatang).toBe(100000n);
    expect(res.value.dueSoonSatang).toBe(30000n);
    expect(res.value.overdueBeforeFySatang).toBe(100000n);
    expect(res.value.overdueBeforeFyCount).toBe(2);
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
    expect(forA.value.overdueBeforeFySatang).toBe(100000n); // #7 + #11 only

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
    // A's two prior-FY bills (#7 + #11) must never leak into B's pair.
    expect(forB.value.overdueBeforeFySatang).toBe(0n);
    expect(forB.value.overdueBeforeFyCount).toBe(0);
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
    // In the FY leg → NOT in the prior-FY pair (mutually exclusive cohorts).
    expect(res.value.overdueBeforeFySatang).toBe(0n);
    expect(res.value.overdueBeforeFyCount).toBe(0);
  }, 60_000);

  it('drops the SAME Feb-due invoice from the cohort under an April fiscal year (prior-FY) — and it lands in the overdueBeforeFy pair instead of vanishing', async () => {
    const res = await loadPipelineMoney(makeRenewalsDeps(fy.ctx.slug), {
      tenantId: fy.ctx.slug,
      nowIso: FY_NOW,
      windowDays: 90,
      fiscalYearStartMonth: 4,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.overdueSatang).toBe(0n);
    // renewals-overdue-prior-fy-subline — the money that used to silently
    // vanish from the band when its due date fell before fyStart is now
    // carried by the prior-FY pair (the sub-line under the Past-due tile).
    expect(res.value.overdueBeforeFySatang).toBe(1234500n);
    expect(res.value.overdueBeforeFyCount).toBe(1);
    // Task 3 — the boundary MOVES with fiscalYearStartMonth, and the
    // surfaced date moves with it (April-start FY at 2026-07-15 →
    // 2026-04-01), so the drill-down's dueBefore always matches the leg.
    expect(res.value.fyStartDate).toBe('2026-04-01');
  }, 60_000);
});

/**
 * 124 slice 2 — one money scenario for the invoice dashboard's integration
 * tests (`invoice-dashboard-figures.test.ts`, `invoice-dashboard-cross-tenant.test.ts`).
 *
 * Every row is seeded with `tx` inside `runInTenant` on a disposable tenant.
 * Amounts are multiplied by `scale`, so the cross-tenant test can seed the
 * SAME scenario in two tenants at different scales and tell a leak from a
 * coincidence. `EXPECTED` below is hand-computed from the rows, line by line,
 * at scale 1 — never derived from the code under test.
 *
 * Fixed `today` = 2026-06-15 (Bangkok), FY 2026 = calendar 2026 (start month 1).
 *
 * The refund that carries a credit note points at it through
 * `refunds.credit_note_id` only; `credit_notes.source_refund_id` stays NULL so
 * there is one FK direction and `tenant.cleanup()` deletes refunds before
 * credit notes without the RESTRICT cycle leak (test-tenant.ts § KNOWN LEAK).
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import type { TestTenant } from '../helpers/test-tenant';
import type { TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

export const TODAY = '2026-06-15';
/** The request instant behind `TODAY` (noon in Bangkok); the pending-refund age is measured from it. */
export const NOW = new Date('2026-06-15T05:00:00Z');

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};
const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
function snapMember(name: string) {
  return {
    legal_name: name,
    tax_id: '1234567890123',
    address: 'Bangkok',
    primary_contact_name: 'n',
    primary_contact_email: 'test@example.com',
  };
}

/** The scenario's invoice ids, by role. */
export interface SeededScenario {
  readonly ids: Record<string, string>;
  /** Every invoice id seeded in the tenant. */
  readonly allInvoiceIds: ReadonlySet<string>;
}

type Plan = { planId: 'gold' | 'silver'; planYear: 2025 | 2026 };
const GOLD: Plan = { planId: 'gold', planYear: 2026 };
const GOLD_2025: Plan = { planId: 'gold', planYear: 2025 };
const SILVER: Plan = { planId: 'silver', planYear: 2026 };

export async function seedInvoiceDashboardScenario(
  tenant: TestTenant,
  user: TestUser,
  scale: bigint,
): Promise<SeededScenario> {
  const slug = tenant.ctx.slug;
  const s = (satang: number): bigint => BigInt(satang) * scale;
  const memberGold = randomUUID();
  const memberSilver = randomUUID();
  const eventId = randomUUID();
  const ids: Record<string, string> = {};
  const invoiceRows: (typeof invoices.$inferInsert)[] = [];
  const paymentRows: (typeof payments.$inferInsert)[] = [];
  const refundRows: (typeof refunds.$inferInsert)[] = [];
  const creditNoteRows: (typeof creditNotes.$inferInsert)[] = [];
  const registrationIds: string[] = [];
  let seq = 0;

  const memberOf = (plan: Plan) => (plan.planId === 'gold' ? memberGold : memberSilver);

  function membership(plan: Plan, origin: 'manual' | 'auto_renewal' = 'manual') {
    return {
      invoiceSubject: 'membership' as const,
      memberId: memberOf(plan),
      planId: plan.planId,
      planYear: plan.planYear,
      origin,
    };
  }
  function event() {
    const registrationId = randomUUID();
    registrationIds.push(registrationId);
    return {
      invoiceSubject: 'event' as const,
      eventId,
      eventRegistrationId: registrationId,
      vatInclusive: true,
      memberId: null,
      planId: null,
      planYear: null,
    };
  }

  function issued(
    key: string,
    subject: ReturnType<typeof membership> | ReturnType<typeof event>,
    o: { issueDate: string; dueDate: string; total: number; docNo?: string },
  ): void {
    seq += 1;
    const invoiceId = randomUUID();
    ids[key] = invoiceId;
    invoiceRows.push({
      tenantId: slug,
      invoiceId,
      ...subject,
      draftByUserId: user.userId,
      status: 'issued',
      pdfDocKind: 'invoice',
      fiscalYear: Number(o.issueDate.slice(0, 4)),
      sequenceNumber: seq,
      documentNumber: o.docNo ?? `DB-2026-${String(seq).padStart(6, '0')}`,
      issueDate: o.issueDate,
      dueDate: o.dueDate,
      subtotalSatang: s(o.total),
      vatRateSnapshot: '0.0700',
      vatSatang: 0n,
      totalSatang: s(o.total),
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: subject.invoiceSubject === 'membership' ? 'monthly' : null,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: snapMember(`Buyer ${key}`),
      pdfBlobKey: `invoicing/db/${key}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    });
  }

  function paid(
    key: string,
    subject: ReturnType<typeof membership> | ReturnType<typeof event>,
    o: {
      issueDate: string;
      total: number;
      paymentDate: string | null;
      paidAt: string;
      method: string;
      status?: 'paid' | 'partially_credited' | 'credited';
      credited?: number;
      receiptPdfStatus?: 'rendered' | 'failed';
    },
  ): void {
    seq += 1;
    const invoiceId = randomUUID();
    ids[key] = invoiceId;
    invoiceRows.push({
      tenantId: slug,
      invoiceId,
      ...subject,
      draftByUserId: user.userId,
      status: o.status ?? 'paid',
      // 088 shape: a pre-payment bill number plus the receipt number.
      billDocumentNumberRaw: `BL-2026-${String(seq).padStart(6, '0')}`,
      receiptDocumentNumberRaw: `RE-2026-${String(seq).padStart(6, '0')}`,
      receiptPdfStatus: o.receiptPdfStatus ?? 'rendered',
      paidAt: new Date(o.paidAt),
      paymentMethod: o.method,
      paymentDate: o.paymentDate,
      fiscalYear: Number(o.issueDate.slice(0, 4)),
      issueDate: o.issueDate,
      dueDate: o.issueDate,
      subtotalSatang: s(o.total),
      vatRateSnapshot: '0.0700',
      vatSatang: 0n,
      totalSatang: s(o.total),
      creditedTotalSatang: s(o.credited ?? 0),
      proRatePolicySnapshot: subject.invoiceSubject === 'membership' ? 'monthly' : null,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: snapMember(`Buyer ${key}`),
      pdfDocKind: 'receipt_separate',
      pdfBlobKey: `invoicing/db/${key}.pdf`,
      pdfSha256: 'b'.repeat(64),
      pdfTemplateVersion: 8,
    });
  }

  function draft(key: string, plan: Plan, origin: 'manual' | 'auto_renewal'): void {
    const invoiceId = randomUUID();
    ids[key] = invoiceId;
    invoiceRows.push({
      tenantId: slug,
      invoiceId,
      ...membership(plan, origin),
      draftByUserId: user.userId,
      dueDate: '2026-07-15',
    });
  }

  function payment(
    key: string,
    invoiceKey: string,
    plan: Plan,
    o: { method: 'card' | 'promptpay'; status: string; amount: number; completedAt: string },
  ): string {
    const id = `pay_${randomUUID()}`;
    ids[key] = id;
    const card = o.method === 'card';
    paymentRows.push({
      id,
      tenantId: slug,
      invoiceId: ids[invoiceKey]!,
      memberId: memberOf(plan),
      method: o.method,
      status: o.status,
      amountSatang: s(o.amount),
      processorPaymentIntentId: `pi_db_${randomUUID()}`,
      processorEnvironment: 'test',
      cardBrand: card ? 'visa' : null,
      cardLast4: card ? '4242' : null,
      cardExpMonth: card ? 12 : null,
      cardExpYear: card ? 2030 : null,
      initiatedAt: new Date(o.completedAt),
      completedAt: new Date(o.completedAt),
      actorUserId: user.userId,
      correlationId: `corr-${key}`,
    });
    return id;
  }

  function refund(
    paymentKey: string,
    invoiceKey: string,
    o: {
      status: 'pending' | 'succeeded' | 'failed';
      amount: number;
      initiatedAt: string;
      completedAt?: string;
      failureReasonCode?: string;
      waiverReason?: 'section_105_receipt' | 'invoice_voided';
      creditNoteKey?: string;
    },
  ): void {
    const settled = o.status === 'succeeded' || o.failureReasonCode?.startsWith('f4_bridge_');
    refundRows.push({
      id: `rf_${randomUUID()}`,
      tenantId: slug,
      paymentId: ids[paymentKey]!,
      invoiceId: ids[invoiceKey]!,
      amountSatang: s(o.amount),
      reason: 'dashboard scenario',
      status: o.status,
      processorRefundId: settled ? `re_db_${randomUUID()}` : null,
      failureReasonCode: o.failureReasonCode ?? null,
      creditNoteId: o.creditNoteKey ? ids[o.creditNoteKey]! : null,
      creditNoteWaiverReason: o.waiverReason ?? null,
      creditNoteWaivedAt: o.waiverReason && o.status === 'succeeded' ? new Date(o.completedAt!) : null,
      initiatedAt: new Date(o.initiatedAt),
      completedAt: o.completedAt ? new Date(o.completedAt) : null,
      initiatorUserId: user.userId,
      correlationId: 'corr-dashboard',
    });
  }

  function creditNote(key: string, invoiceKey: string, o: { issueDate: string; total: number }): void {
    seq += 1;
    const creditNoteId = randomUUID();
    ids[key] = creditNoteId;
    creditNoteRows.push({
      tenantId: slug,
      creditNoteId,
      originalInvoiceId: ids[invoiceKey]!,
      fiscalYear: Number(o.issueDate.slice(0, 4)),
      sequenceNumber: seq,
      documentNumber: `CN-2026-${String(seq).padStart(6, '0')}`,
      issueDate: o.issueDate,
      issuedByUserId: user.userId,
      reason: 'dashboard scenario',
      creditAmountSatang: s(o.total),
      vatSatang: 0n,
      totalSatang: s(o.total),
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: snapMember(`Buyer ${invoiceKey}`),
      pdfBlobKey: `invoicing/db/${key}.pdf`,
      pdfSha256: 'c'.repeat(64),
      pdfTemplateVersion: 8,
    });
  }

  // --- Issued (Outstanding, all years) --------------------------------------
  // Aging edges against today = 2026-06-15: due today → not yet due;
  // 2026-05-16 (30 days) → 1–30; 2026-05-15 (31 days) → 31–60;
  // 2026-04-15 (61 days) → 61–90; 2026-03-16 (91 days) → over 90.
  issued('iDueToday', membership(GOLD), { issueDate: '2026-05-16', dueDate: '2026-06-15', total: 100_000 });
  issued('iFuture', membership(SILVER), { issueDate: '2026-06-10', dueDate: '2026-07-30', total: 200_000 });
  issued('iD1', membership(GOLD), { issueDate: '2026-05-15', dueDate: '2026-06-14', total: 10_000 });
  issued('iD30', membership(SILVER), { issueDate: '2026-04-16', dueDate: '2026-05-16', total: 20_000 });
  // Three due the same day: amount desc, then document number asc.
  issued('iD31', membership(GOLD), { issueDate: '2026-04-15', dueDate: '2026-05-15', total: 40_000, docNo: 'DB-2026-900003' });
  issued('iD31b', membership(GOLD), { issueDate: '2026-04-15', dueDate: '2026-05-15', total: 50_000, docNo: 'DB-2026-900009' });
  issued('iD31c', membership(SILVER), { issueDate: '2026-04-15', dueDate: '2026-05-15', total: 40_000, docNo: 'DB-2026-900002' });
  // Auto-renewal, on the 2025 row of plan `gold` (a Plan filter matches every plan year).
  issued('iD61', membership(GOLD_2025, 'auto_renewal'), { issueDate: '2026-03-16', dueDate: '2026-04-15', total: 80_000 });
  // Event invoice, issued in the prior FY, still unpaid.
  issued('iD91', event(), { issueDate: '2025-12-16', dueDate: '2026-03-16', total: 160_000 });

  // --- Drafts (Needs attention only) -----------------------------------------
  draft('dManualGold', GOLD, 'manual');
  draft('dManualSilver', SILVER, 'manual');
  draft('dAuto', GOLD, 'auto_renewal');

  // --- Void: excluded from Billed; its invoice_voided refund never nets ------
  seq += 1;
  ids.vVoid = randomUUID();
  invoiceRows.push({
    tenantId: slug,
    invoiceId: ids.vVoid,
    ...membership(GOLD),
    draftByUserId: user.userId,
    status: 'void',
    voidedAt: new Date('2026-02-12T03:00:00Z'),
    voidReason: 'dashboard scenario',
    voidedByUserId: user.userId,
    pdfDocKind: 'invoice',
    fiscalYear: 2026,
    sequenceNumber: seq,
    documentNumber: `DB-2026-${String(seq).padStart(6, '0')}`,
    issueDate: '2026-02-10',
    dueDate: '2026-03-10',
    subtotalSatang: s(30_000),
    vatRateSnapshot: '0.0700',
    vatSatang: 0n,
    totalSatang: s(30_000),
    creditedTotalSatang: 0n,
    proRatePolicySnapshot: 'monthly',
    netDaysSnapshot: 30,
    tenantIdentitySnapshot: SNAP_TENANT,
    memberIdentitySnapshot: snapMember('Buyer vVoid'),
    // A stale receipt-render failure on a non-paid invoice is not a receipt
    // to re-render: Needs attention counts paid-family invoices only.
    receiptPdfStatus: 'failed',
    pdfBlobKey: 'invoicing/db/vVoid.pdf',
    pdfSha256: 'd'.repeat(64),
    pdfTemplateVersion: 1,
  });

  // --- Paid family, FY 2026 --------------------------------------------------
  paid('pBank', membership(GOLD), {
    issueDate: '2026-02-20', total: 1_070_000, paymentDate: '2026-03-05',
    paidAt: '2026-03-05T05:00:00Z', method: 'bank_transfer',
  });
  // No payment_date: the tax point falls back to paid_at AS A BANGKOK DATE —
  // 2026-05-31T17:30Z is 2026-06-01 in Bangkok (June, the current month).
  paid('pPaidAtFallback', membership(SILVER), {
    issueDate: '2026-05-20', total: 535_000, paymentDate: null,
    paidAt: '2026-05-31T17:30:00Z', method: 'cash',
  });
  // Stripe-paid: invoices.payment_method is 'other'; two payments rows in the
  // method set (an older refunded PromptPay, a newer succeeded card) → card, once.
  paid('pStripeCard', membership(GOLD), {
    issueDate: '2026-04-01', total: 214_000, paymentDate: '2026-04-03',
    paidAt: '2026-04-03T05:00:00Z', method: 'other',
  });
  // PromptPay, refunded in part WITH a credit note issued in a later month.
  paid('pPromptPartial', membership(GOLD), {
    issueDate: '2026-03-01', total: 321_000, paymentDate: '2026-03-10',
    paidAt: '2026-03-10T05:00:00Z', method: 'other', status: 'partially_credited', credited: 107_000,
  });
  // Offline payment with a manual credit note (no refund row).
  paid('pManualCN', membership(SILVER), {
    issueDate: '2026-02-01', total: 428_000, paymentDate: '2026-02-15',
    paidAt: '2026-02-15T05:00:00Z', method: 'bank_transfer', status: 'partially_credited', credited: 42_800,
  });
  // §105 receipt: a waived (no credit note) refund completed 2026-04-30T23:30Z
  // = 2026-05-01 in Bangkok → nets in May.
  paid('pWaived105', membership(GOLD), {
    issueDate: '2026-04-05', total: 642_000, paymentDate: '2026-04-10',
    paidAt: '2026-04-10T05:00:00Z', method: 'other',
  });
  // A legacy `failed` + f4_bridge_% refund: Stripe paid out, never booked,
  // never netted; Needs attention row 5 counts it (D-k) so it is not invisible.
  paid('pF4', membership(SILVER), {
    issueDate: '2026-05-15', total: 856_000, paymentDate: '2026-05-20',
    paidAt: '2026-05-20T05:00:00Z', method: 'other',
  });
  paid('pEventPaid', event(), {
    issueDate: '2026-05-01', total: 963_000, paymentDate: '2026-05-10',
    paidAt: '2026-05-10T05:00:00Z', method: 'bank_transfer',
  });
  paid('pAutoPaid', membership(GOLD_2025, 'auto_renewal'), {
    issueDate: '2026-01-10', total: 1_177_000, paymentDate: '2026-01-20',
    paidAt: '2026-01-20T05:00:00Z', method: 'cheque',
  });

  // --- Paid in FY 2025: the refund-attempt history behind Needs attention ----
  paid('aX', membership(GOLD), {
    issueDate: '2025-08-01', total: 100_000, paymentDate: '2025-08-01',
    paidAt: '2025-08-01T05:00:00Z', method: 'other', receiptPdfStatus: 'failed',
  });
  paid('aY', membership(GOLD), {
    issueDate: '2025-08-01', total: 100_000, paymentDate: '2025-08-01',
    paidAt: '2025-08-01T05:00:00Z', method: 'other',
  });
  paid('aZ', membership(GOLD), {
    issueDate: '2025-08-01', total: 100_000, paymentDate: '2025-08-01',
    paidAt: '2025-08-01T05:00:00Z', method: 'other',
  });
  paid('aW', membership(GOLD), {
    issueDate: '2025-08-01', total: 100_000, paymentDate: '2025-08-01',
    paidAt: '2025-08-01T05:00:00Z', method: 'other',
  });

  // Payments.
  payment('payVoid', 'vVoid', GOLD, { method: 'card', status: 'refunded', amount: 30_000, completedAt: '2026-02-11T03:00:00Z' });
  payment('payStripeOld', 'pStripeCard', GOLD, { method: 'promptpay', status: 'refunded', amount: 214_000, completedAt: '2026-04-01T03:00:00Z' });
  payment('payStripeNew', 'pStripeCard', GOLD, { method: 'card', status: 'succeeded', amount: 214_000, completedAt: '2026-04-03T03:00:00Z' });
  payment('payPrompt', 'pPromptPartial', GOLD, { method: 'promptpay', status: 'partially_refunded', amount: 321_000, completedAt: '2026-03-10T03:00:00Z' });
  payment('payWaived', 'pWaived105', GOLD, { method: 'card', status: 'partially_refunded', amount: 642_000, completedAt: '2026-04-10T03:00:00Z' });
  payment('payF4', 'pF4', SILVER, { method: 'card', status: 'succeeded', amount: 856_000, completedAt: '2026-05-20T03:00:00Z' });
  payment('payX', 'aX', GOLD, { method: 'card', status: 'succeeded', amount: 100_000, completedAt: '2025-08-01T03:00:00Z' });
  payment('payY', 'aY', GOLD, { method: 'card', status: 'succeeded', amount: 100_000, completedAt: '2025-08-01T03:00:00Z' });
  payment('payZ', 'aZ', GOLD, { method: 'card', status: 'succeeded', amount: 100_000, completedAt: '2025-08-01T03:00:00Z' });
  payment('payW', 'aW', GOLD, { method: 'card', status: 'partially_refunded', amount: 100_000, completedAt: '2025-08-01T03:00:00Z' });

  // Credit notes.
  creditNote('cnRefund', 'pPromptPartial', { issueDate: '2026-04-20', total: 107_000 });
  creditNote('cnManual', 'pManualCN', { issueDate: '2026-05-05', total: 42_800 });

  // Refunds.
  refund('payVoid', 'vVoid', {
    status: 'succeeded', amount: 30_000, initiatedAt: '2026-02-12T02:00:00Z',
    completedAt: '2026-02-12T03:00:00Z', waiverReason: 'invoice_voided',
  });
  refund('payPrompt', 'pPromptPartial', {
    status: 'succeeded', amount: 107_000, initiatedAt: '2026-04-20T02:00:00Z',
    completedAt: '2026-04-20T03:00:00Z', creditNoteKey: 'cnRefund',
  });
  refund('payWaived', 'pWaived105', {
    status: 'succeeded', amount: 64_200, initiatedAt: '2026-04-30T23:00:00Z',
    completedAt: '2026-04-30T23:30:00Z', waiverReason: 'section_105_receipt',
  });
  refund('payF4', 'pF4', {
    status: 'failed', amount: 100_000, initiatedAt: '2026-05-21T02:00:00Z',
    completedAt: '2026-05-21T03:00:00Z', failureReasonCode: 'f4_bridge_error',
  });
  // X: two attempts failed at Stripe, none succeeded or pending after them →
  // counted ONCE (a payment is one item, not one per attempt).
  refund('payX', 'aX', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-02T03:00:00Z', completedAt: '2025-08-02T04:00:00Z', failureReasonCode: 'stripe_refund_failed' });
  refund('payX', 'aX', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-03T03:00:00Z', completedAt: '2025-08-03T04:00:00Z', failureReasonCode: 'stripe_refund_canceled' });
  // Y: a later attempt is pending → not counted as failed at Stripe; that
  // pending attempt (2025-08-04, far past 3 days before NOW) is row 5's one.
  refund('payY', 'aY', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-02T03:00:00Z', completedAt: '2025-08-02T04:00:00Z', failureReasonCode: 'stripe_refund_failed' });
  refund('payY', 'aY', { status: 'pending', amount: 10_000, initiatedAt: '2025-08-04T03:00:00Z' });
  // Z: a Stripe failure, then a later gateway refusal ('permanent'): no later
  // attempt succeeded or is pending, so the Stripe failure still counts (US1).
  refund('payZ', 'aZ', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-02T03:00:00Z', completedAt: '2025-08-02T04:00:00Z', failureReasonCode: 'stripe_refund_failed' });
  refund('payZ', 'aZ', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-05T03:00:00Z', completedAt: '2025-08-05T04:00:00Z', failureReasonCode: 'permanent' });
  // W: a later attempt succeeded → not counted.
  refund('payW', 'aW', { status: 'failed', amount: 10_000, initiatedAt: '2025-08-02T03:00:00Z', completedAt: '2025-08-02T04:00:00Z', failureReasonCode: 'stripe_refund_failed' });
  refund('payW', 'aW', {
    status: 'succeeded', amount: 10_000, initiatedAt: '2025-08-06T03:00:00Z',
    completedAt: '2025-08-06T04:00:00Z', waiverReason: 'section_105_receipt',
  });

  await runInTenant(tenant.ctx, async (tx) => {
    for (const plan of [GOLD, GOLD_2025, SILVER]) {
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: plan.planId,
        planYear: plan.planYear,
        planName: { en: `Plan ${plan.planId}` },
        description: { en: 'desc' },
        sortOrder: plan.planId === 'gold' ? 10 : 20,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    }
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 0n,
      legalNameTh: SNAP_TENANT.legal_name_th,
      legalNameEn: SNAP_TENANT.legal_name_en,
      taxId: SNAP_TENANT.tax_id,
      registeredAddressTh: SNAP_TENANT.address_th,
      registeredAddressEn: SNAP_TENANT.address_en,
      invoiceNumberPrefix: 'DB',
      creditNoteNumberPrefix: 'DBC',
    });
    await tx.insert(members).values([
      {
        tenantId: slug,
        memberId: memberGold,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Gold Co',
        country: 'TH',
        planId: 'gold',
        planYear: 2026,
      },
      {
        tenantId: slug,
        memberId: memberSilver,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Silver Co',
        country: 'TH',
        planId: 'silver',
        planYear: 2026,
      },
    ]);
    await tx.insert(events).values({
      tenantId: slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt_db_${randomUUID()}`,
      name: 'Dashboard Gala',
      startDate: new Date('2026-05-01T11:00:00Z'),
    });
    await tx.insert(eventRegistrations).values(
      registrationIds.map((registrationId, i) => ({
        tenantId: slug,
        registrationId,
        eventId,
        externalId: `att_db_${i}_${randomUUID()}`,
        attendeeEmail: `guest${i}@example.com`,
        attendeeName: 'Walk-in Guest',
        attendeeCompany: 'Walk-in Guest Ltd',
        matchType: 'non_member' as const,
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid' as const,
        registeredAt: new Date('2026-04-10T03:00:00Z'),
      })),
    );
    await tx.insert(invoices).values(invoiceRows);
    await tx.insert(creditNotes).values(creditNoteRows);
    await tx.insert(payments).values(paymentRows);
    await tx.insert(refunds).values(refundRows);
  });

  return {
    ids,
    allInvoiceIds: new Set(invoiceRows.map((r) => r.invoiceId!)),
  };
}

/**
 * The scenario's figures at scale 1, hand-computed from the rows above
 * (satang). Multiply amounts by the scale; counts do not scale.
 */
export const EXPECTED = {
  // 100,000 + 200,000 (not yet due) | 10,000 + 20,000 | 40,000 + 50,000 + 40,000
  // | 80,000 | 160,000.
  aging: {
    not_yet_due: { amountSatang: 300_000n, count: 2 },
    days_1_30: { amountSatang: 30_000n, count: 2 },
    days_31_60: { amountSatang: 130_000n, count: 3 },
    days_61_90: { amountSatang: 80_000n, count: 1 },
    over_90: { amountSatang: 160_000n, count: 1 },
  },
  outstanding: { amountSatang: 700_000n, count: 9 },
  overdue: { amountSatang: 400_000n, count: 7 },
  // June: only pPaidAtFallback (tax point = Bangkok date of paid_at).
  collectedThisMonth: { amountSatang: 535_000n, invoiceCount: 1 },
  // Nine paid-family invoices with a 2026 tax point (6,206,000)
  // − credit notes 107,000 + 42,800 − the waived §105 refund 64,200.
  collectedInFiscalYear: { amountSatang: 5_992_000n, invoiceCount: 9 },
  methods: {
    bank_transfer: 2_418_200n, // 1,070,000 + 428,000 + 963,000 − 42,800
    promptpay: 214_000n, // 321,000 − 107,000
    card: 1_647_800n, // 214,000 + 642,000 + 856,000 − 64,200
    cheque: 1_177_000n,
    cash: 535_000n,
    other: 0n,
  },
  trend: {
    '2026-01': { billed: 1_177_000n, collected: 1_177_000n },
    '2026-02': { billed: 1_498_000n, collected: 428_000n },
    '2026-03': { billed: 401_000n, collected: 1_391_000n },
    '2026-04': { billed: 899_000n, collected: 749_000n },
    '2026-05': { billed: 2_421_200n, collected: 1_712_000n },
    '2026-06': { billed: 200_000n, collected: 535_000n },
  },
  attention: {
    manualDrafts: 2,
    autoRenewalDrafts: 1,
    // aX (paid); vVoid's stale `failed` receipt status is not counted.
    receiptPdfFailed: 1,
    // payX and payZ; not payY (later pending) nor payW (later succeeded).
    refundsFailedAtStripe: 2,
    // payY's pending attempt (gold) + pF4's legacy failed f4_bridge_% refund (silver, D-k).
    refundsPendingOverThreshold: 2,
  },
  /** Overdue set, longest past due first, then amount desc, then number asc. */
  oldestOverdueOrder: ['iD91', 'iD61', 'iD31b', 'iD31c', 'iD31', 'iD30', 'iD1'],
} as const;

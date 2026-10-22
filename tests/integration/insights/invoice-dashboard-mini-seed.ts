/**
 * 124 slice 2 — a small seeder for the invoice dashboard's edge-case
 * integration tests (pending-refund age, payment-method fallback), kept apart
 * from `invoice-dashboard-seed.ts` so adding a row here never moves that
 * scenario's hand-computed figures.
 *
 * One `gold` plan (2026) and one member per tenant; paid-family invoices,
 * their `payments` rows and `refunds` rows, all inserted with `tx` inside
 * `runInTenant` on a disposable tenant. Shapes follow the main seed, which
 * documents the CHECK constraints each one satisfies.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import type { TestTenant } from '../helpers/test-tenant';
import type { TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

export interface MiniPaidInvoice {
  readonly key: string;
  readonly total: number;
  /** `invoices.payment_method` — the fallback when no payments row stands for the invoice. */
  readonly method: string;
  readonly paymentDate: string;
}

export interface MiniPayment {
  readonly key: string;
  readonly invoiceKey: string;
  readonly method: 'card' | 'promptpay';
  readonly amount: number;
  readonly completedAt: string;
}

export interface MiniRefund {
  readonly paymentKey: string;
  readonly invoiceKey: string;
  readonly status: 'pending' | 'succeeded';
  readonly amount: number;
  readonly initiatedAt: Date;
}

export interface MiniScenario {
  readonly invoices: readonly MiniPaidInvoice[];
  readonly payments?: readonly MiniPayment[];
  readonly refunds?: readonly MiniRefund[];
}

/** Seeds `scenario` in `tenant`; returns the ids by key. */
export async function seedMiniScenario(
  tenant: TestTenant,
  user: TestUser,
  scenario: MiniScenario,
): Promise<Record<string, string>> {
  const slug = tenant.ctx.slug;
  const memberId = randomUUID();
  const ids: Record<string, string> = {};
  let seq = 0;

  const invoiceRows = scenario.invoices.map((o) => {
    seq += 1;
    const invoiceId = randomUUID();
    ids[o.key] = invoiceId;
    return {
      tenantId: slug,
      invoiceId,
      invoiceSubject: 'membership' as const,
      memberId,
      planId: 'gold',
      planYear: 2026,
      origin: 'manual' as const,
      draftByUserId: user.userId,
      status: 'paid' as const,
      billDocumentNumberRaw: `BL-2026-${String(seq).padStart(6, '0')}`,
      receiptDocumentNumberRaw: `RE-2026-${String(seq).padStart(6, '0')}`,
      receiptPdfStatus: 'rendered' as const,
      paidAt: new Date(`${o.paymentDate}T05:00:00Z`),
      paymentMethod: o.method,
      paymentDate: o.paymentDate,
      fiscalYear: Number(o.paymentDate.slice(0, 4)),
      issueDate: o.paymentDate,
      dueDate: o.paymentDate,
      subtotalSatang: BigInt(o.total),
      vatRateSnapshot: '0.0700',
      vatSatang: 0n,
      totalSatang: BigInt(o.total),
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly' as const,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: {
        legal_name: `Buyer ${o.key}`,
        tax_id: '1234567890123',
        address: 'Bangkok',
        primary_contact_name: 'n',
        primary_contact_email: 'test@example.com',
      },
      pdfDocKind: 'receipt_separate' as const,
      pdfBlobKey: `invoicing/mini/${o.key}.pdf`,
      pdfSha256: 'b'.repeat(64),
      pdfTemplateVersion: 8,
    };
  });

  const paymentRows = (scenario.payments ?? []).map((o) => {
    const id = `pay_${randomUUID()}`;
    ids[o.key] = id;
    const card = o.method === 'card';
    return {
      id,
      tenantId: slug,
      invoiceId: ids[o.invoiceKey]!,
      memberId,
      method: o.method,
      status: 'succeeded',
      amountSatang: BigInt(o.amount),
      processorPaymentIntentId: `pi_mini_${randomUUID()}`,
      processorEnvironment: 'test',
      cardBrand: card ? 'visa' : null,
      cardLast4: card ? '4242' : null,
      cardExpMonth: card ? 12 : null,
      cardExpYear: card ? 2030 : null,
      initiatedAt: new Date(o.completedAt),
      completedAt: new Date(o.completedAt),
      actorUserId: user.userId,
      correlationId: `corr-${o.key}`,
    };
  });

  const refundRows = (scenario.refunds ?? []).map((o) => {
    const succeeded = o.status === 'succeeded';
    const completedAt = succeeded ? new Date(o.initiatedAt.getTime() + 60 * 60 * 1000) : null;
    return {
      id: `rf_${randomUUID()}`,
      tenantId: slug,
      paymentId: ids[o.paymentKey]!,
      invoiceId: ids[o.invoiceKey]!,
      amountSatang: BigInt(o.amount),
      reason: 'dashboard edge case',
      status: o.status,
      processorRefundId: succeeded ? `re_mini_${randomUUID()}` : null,
      failureReasonCode: null,
      creditNoteId: null,
      creditNoteWaiverReason: succeeded ? ('section_105_receipt' as const) : null,
      creditNoteWaivedAt: completedAt,
      initiatedAt: o.initiatedAt,
      completedAt,
      initiatorUserId: user.userId,
      correlationId: 'corr-dashboard-mini',
    };
  });

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: slug,
      planId: 'gold',
      planYear: 2026,
      planName: { en: 'Plan gold' },
      description: { en: 'desc' },
      sortOrder: 10,
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
    await tx.insert(members).values({
      tenantId: slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Gold Co',
      country: 'TH',
      planId: 'gold',
      planYear: 2026,
    });
    await tx.insert(invoices).values(invoiceRows);
    if (paymentRows.length > 0) await tx.insert(payments).values(paymentRows);
    if (refundRows.length > 0) await tx.insert(refunds).values(refundRows);
  });

  return ids;
}

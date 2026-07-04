/**
 * 088-invoice-tax-flow-redesign — T015a [US1] Integration (live Neon):
 * the §87 `RC` §86/4 tax-receipt register is CONTIGUOUS / gap-free across
 * INTERLEAVED membership + event-with-TIN payments in one fiscal year (SC-002).
 *
 * Both a membership payment (record-payment) and an event-with-TIN as-paid
 * issuance (issue-event-invoice-as-paid) mint their §86/4 RC number from the
 * SAME `receipt` §87 stream in the new flow, so the RC series must stay
 * strictly consecutive with no gap when the two are interleaved:
 *
 *   membership A → pay → RC N
 *   event+TIN    → as-paid → RC N+1
 *   membership B → pay → RC N+2
 *
 * REAL allocator + repo + audit; PDF/Blob mocked. `taxAtPayment: true`.
 * Migrations 0230 + 0231 MUST be applied first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { issueEventInvoiceAsPaid } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeIssueEventInvoiceAsPaidDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
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

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PAYMENT_DATE = '2026-07-01';

const EVENT_BUYER_TIN = {
  legal_name: 'RC No-Gaps Event Corp',
  tax_id: '1234512345123',
  address: '1 Silom Road, Bangkok 10500',
  primary_contact_name: 'Event Buyer',
  primary_contact_email: 'buyer@rcnogaps.example',
} as const;

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_i: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDeps(slug: string) {
  return { ...makeIssueInvoiceDeps(slug), ...mockPdfBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment: 'on' as const };
}
function recordDeps(slug: string) {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on' as const,
    asyncReceiptPdf: false,
  };
}
function asPaidDeps(slug: string) {
  return {
    ...makeIssueEventInvoiceAsPaidDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on' as const,
  };
}

describe('088 US1 — §86/4 RC register gap-free across interleaved membership + event-with-TIN (live Neon, SC-002)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'rc-no-gaps-plan';
  const planYear = 2026;
  let eventId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    eventId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'RC No-Gaps Plan' },
        description: { en: 'Plan for the RC no-gaps SC-002 test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
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
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_rc_no_gaps',
        name: 'RC No-Gaps Gala',
        startDate: new Date('2026-08-15T10:00:00Z'),
      } satisfies NewEventRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function seedMember(): Promise<{ memberId: string }> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `RC Member ${memberId.slice(0, 8)}`,
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'RC',
        lastName: 'Member',
        email: `rc.${memberId.slice(0, 8)}@member.example`,
        isPrimary: true,
      });
    });
    return { memberId };
  }

  async function seedEventReg(externalSuffix: string): Promise<string> {
    const registrationId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId,
        eventId,
        externalId: `att_rc_${externalSuffix}`,
        attendeeEmail: 'buyer@rcnogaps.example',
        attendeeName: 'Event Buyer',
        attendeeCompany: 'RC No-Gaps Event Corp',
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 1070,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-07-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
    return registrationId;
  }

  async function payMembershipGetRc(memberId: string, tag: string): Promise<number> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rc-draft-${tag}-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`membership draft ${tag}: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rc-issue-${tag}-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`membership issue ${tag}: ${JSON.stringify(issued)}`);
    const paid = await recordPayment(recordDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rc-pay-${tag}-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    if (!paid.ok) throw new Error(`membership pay ${tag}: ${JSON.stringify(paid)}`);
    return rcSeq(paid.value.receiptDocumentNumberRaw, `membership ${tag}`);
  }

  async function payEventTinGetRc(regId: string, tag: string): Promise<number> {
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rc-evt-draft-${tag}-${regId}`,
      eventRegistrationId: regId,
      amountOverride: 107_000, // 1,070 THB inclusive
      buyer: EVENT_BUYER_TIN,
    });
    if (!draft.ok) throw new Error(`event draft ${tag}: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;
    const asPaid = await issueEventInvoiceAsPaid(asPaidDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rc-evt-aspaid-${tag}-${invoiceId}`,
      invoiceId,
      paymentDate: PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    if (!asPaid.ok) throw new Error(`event as-paid ${tag}: ${JSON.stringify(asPaid)}`);
    return rcSeq(asPaid.value.receiptDocumentNumberRaw, `event ${tag}`);
  }

  function rcSeq(raw: string | null, label: string): number {
    expect(raw, `${label} must carry an RC receipt number`).not.toBeNull();
    expect(raw, `${label} RC number must use the RC prefix`).toMatch(/^RC-2026-\d{6}$/);
    const parsed = DocumentNumber.parse(raw!);
    if (!parsed.ok) throw new Error(`unparseable RC number ${raw} for ${label}`);
    return parsed.value.sequenceNumber;
  }

  it('membership → event-with-TIN → membership payments mint strictly consecutive RC numbers', async () => {
    const { memberId: memberA } = await seedMember();
    const regTin = await seedEventReg('interleave');
    const { memberId: memberB } = await seedMember();

    const rc1 = await payMembershipGetRc(memberA, 'A');
    const rc2 = await payEventTinGetRc(regTin, 'evt');
    const rc3 = await payMembershipGetRc(memberB, 'B');

    // Strictly consecutive on the ONE shared §86/4 `receipt` register — the
    // interleave left NO gap between the membership and event-with-TIN RCs.
    expect(rc2).toBe(rc1 + 1);
    expect(rc3).toBe(rc2 + 1);

    // Cross-check the DB: exactly three `receipt`-stream RC rows for this tenant
    // carry consecutive numbers and none carry a §87 invoice sequence.
    const paidRows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.status, 'paid')));
    const rcRows = paidRows.filter((r) => (r.receiptDocumentNumberRaw ?? '').startsWith('RC-2026-'));
    expect(rcRows.length).toBeGreaterThanOrEqual(3);
    for (const r of rcRows) {
      // A §86/4 RC receipt never occupies the §87 invoice-stream pair.
      expect(r.sequenceNumber).toBeNull();
      expect(r.documentNumber).toBeNull();
    }
  }, 120_000);
});

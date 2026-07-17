/**
 * 066 §4.4(1) (review C3/C4) — the F4 record-payment terminated-membership
 * gate, end-to-end on live Neon with the REAL invoicing→renewals bridge.
 *
 * Matrix (subject × trigger × access):
 *   membership + admin-manual + terminated → err membership_terminated,
 *       NO §87 receipt allocated, invoice stays issued
 *   membership + webhook      + terminated → PASSES (money already captured;
 *       receipt mints — the gate must never wedge the webhook)
 *   membership + admin-manual + suspended  → passes (awaiting_payment member)
 *   membership + admin-manual + no cycle   → passes (imported cohort)
 *   event      + admin-manual + terminated → NOT gated (subject filter)
 *
 * PDF render + Blob upload are mocked (bill-to-receipt harness pattern);
 * the allocator + repo + audit + settings + the membership-access bridge
 * are all real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = '2026-09-30T08:00:00.000Z';
const PAYMENT_DATE = '2026-09-30';

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

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
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

function issueDeps(slug: string): IssueInvoiceDeps {
  return { ...makeIssueInvoiceDeps(slug), ...mockPdfBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment: 'on' };
}
function recordDeps(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
    asyncReceiptPdf: false,
  };
}

describe('066 record-payment terminated-membership gate (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'terminated-gate-plan';
  const planYear = 2026;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thai-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Gate Plan' },
        description: { en: 'terminated-gate test' },
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
      }),
    );
  }, 60_000);

  afterAll(async () => {
    for (const table of [
      eventRegistrations,
      events,
      renewalCycles,
      invoices,
      contacts,
      members,
    ] as const) {
      await db.delete(table).where(eq(table.tenantId, tenant.ctx.slug)).catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /** Create a member + primary contact; optionally a renewal cycle of a state. */
  async function seedMember(cycleStatus: 'lapsed' | 'awaiting_payment' | null): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Gate Member Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV',
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
        firstName: 'Gate',
        lastName: 'Contact',
        email: `gate-${randomUUID().slice(0, 8)}@g.example`,
        isPrimary: true,
      });
      if (cycleStatus) {
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: cycleStatus,
          periodFrom: new Date(Date.now() - 400 * MS_PER_DAY),
          periodTo: new Date(Date.now() - 35 * MS_PER_DAY),
          expiresAt: new Date(Date.now() - 35 * MS_PER_DAY),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          ...(cycleStatus === 'lapsed'
            ? { closedAt: new Date(Date.now() - 30 * MS_PER_DAY), closedReason: 'grace_expired' }
            : {}),
        });
      }
    });
    return memberId;
  }

  /** Draft + issue a membership bill for a member; returns invoiceId. */
  async function issuedMembershipBill(memberId: string): Promise<string> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `gate-draft-${randomUUID()}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `gate-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
    return invoiceId;
  }

  async function readInvoice(invoiceId: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  function pay(invoiceId: string, triggeredBy: 'admin_manual' | 'webhook') {
    return recordPayment(recordDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `gate-pay-${randomUUID()}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
      triggeredBy,
    });
  }

  it('membership + admin-manual + terminated → err membership_terminated, invoice unchanged, no §87 receipt', async () => {
    const memberId = await seedMember('lapsed');
    const invoiceId = await issuedMembershipBill(memberId);

    const r = await pay(invoiceId, 'admin_manual');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('membership_terminated');

    const row = await readInvoice(invoiceId);
    expect(row!.status).toBe('issued'); // untouched
    expect(row!.receiptDocumentNumberRaw).toBeNull(); // no §86/4 minted
  });

  it('membership + webhook + terminated → PASSES (gate never wedges the webhook; receipt mints)', async () => {
    const memberId = await seedMember('lapsed');
    const invoiceId = await issuedMembershipBill(memberId);

    const r = await pay(invoiceId, 'webhook');
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    const row = await readInvoice(invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
  });

  it('membership + admin-manual + suspended (awaiting_payment) → passes', async () => {
    const memberId = await seedMember('awaiting_payment');
    const invoiceId = await issuedMembershipBill(memberId);
    const r = await pay(invoiceId, 'admin_manual');
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
  });

  it('membership + admin-manual + no cycle (imported cohort) → passes', async () => {
    const memberId = await seedMember(null);
    const invoiceId = await issuedMembershipBill(memberId);
    const r = await pay(invoiceId, 'admin_manual');
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
  });

  it('event subject + admin-manual + terminated member → NOT gated (subject filter)', async () => {
    const memberId = await seedMember('lapsed');
    // Raw-seed an ISSUED event invoice for the terminated member.
    const eventId = randomUUID();
    const registrationId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        eventId,
        tenantId: tenant.ctx.slug,
        externalId: `evt-gate-${randomUUID().slice(0, 8)}`,
        source: 'admin_manual',
        name: 'Gate subject-filter event',
        startDate: new Date('2099-01-01T00:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      });
      await tx.insert(eventRegistrations).values({
        registrationId,
        tenantId: tenant.ctx.slug,
        eventId,
        externalId: `att-${randomUUID().slice(0, 8)}`,
        attendeeEmail: `att-${randomUUID().slice(0, 8)}@g.example`,
        attendeeName: 'Gate Attendee',
        matchType: 'non_member',
        paymentStatus: 'pending',
        registeredAt: new Date(),
      });
    });
    const eventInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: eventInvoiceId,
        memberId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: registrationId,
        planId: null,
        planYear: null,
        draftByUserId: user.userId,
        status: 'issued',
        dueDate: '2026-09-01',
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: 990001,
        documentNumber: 'INV-2026-990001',
        issueDate: '2026-08-01',
        currency: 'THB',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: {
          legal_name_th: 'x',
          legal_name_en: 'x',
          tax_id: '0000000000000',
          address_th: 'x',
          address_en: 'x',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'Gate Member Corp',
          tax_id: '9999999999999',
          address: 'x',
          primary_contact_name: 'Gate',
          primary_contact_email: 'gate@g.example',
        },
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${eventInvoiceId}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );

    const r = await pay(eventInvoiceId, 'admin_manual');
    // The gate's `invoiceSubject === 'membership'` conjunct means an event
    // invoice is never blocked by it — regardless of the member's terminated
    // state. It may pass or fail downstream on event specifics, but NEVER
    // with membership_terminated.
    if (!r.ok) expect(r.error.code).not.toBe('membership_terminated');
  });
});

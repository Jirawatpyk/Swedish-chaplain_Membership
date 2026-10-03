/**
 * #512 — a stale confirmed total is refused BEFORE a document number is
 * allocated, against the real allocator and the real transaction.
 *
 * The unit suite proves `allocateNext` is never called on `issue_total_changed`
 * (a spy). What it cannot prove is the database outcome: `issueInvoice` runs in
 * one `withTx`, and a refusal RETURNED as `err(...)` from inside it — not thrown
 * as `IssueInvoiceInternalError` — resolves the callback normally, so the
 * allocator's increment COMMITS. Were the guard ever moved below
 * `allocateNext`, the cost would be a consumed §87 number and a gap in the
 * register. This test pins that cost against the real allocator: the sequence
 * rows are untouched, the draft stays a draft, and the next successful issue
 * takes the very first number. Legacy flow (`taxAtPayment: 'off'`), so the
 * stream is the §87 tax-invoice register, where a gap is unlawful.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const FIXED_NOW = '2026-09-30T08:00:00.000Z';

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

function issueDeps(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'off',
  };
}

describe('#512 issue_total_changed — no document number consumed (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'stale-total-plan';
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
        planName: { en: 'Stale Total Plan' },
        description: { en: '#512 stale-total sequence test' },
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
    await db
      .execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${tenant.ctx.slug}`)
      .catch(() => {});
    for (const table of [invoices, contacts, members] as const) {
      await db.delete(table).where(eq(table.tenantId, tenant.ctx.slug)).catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedDraft(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Stale Total Corp',
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
        firstName: 'Stale',
        lastName: 'Total',
        email: `stale-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      });
    });
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `st-draft-${randomUUID()}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
    return draft.value.invoiceId;
  }

  async function sequenceRows() {
    return db
      .select({
        documentType: tenantDocumentSequences.documentType,
        fiscalYear: tenantDocumentSequences.fiscalYear,
        next: tenantDocumentSequences.nextSequenceNumber,
      })
      .from(tenantDocumentSequences)
      .where(eq(tenantDocumentSequences.tenantId, tenant.ctx.slug));
  }

  async function invoiceRow(invoiceId: string) {
    const [row] = await db
      .select({
        status: invoices.status,
        sequenceNumber: invoices.sequenceNumber,
        documentNumber: invoices.documentNumber,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  it('refuses the stale total, leaves the register untouched, and the next issue takes the first number', async () => {
    const invoiceId = await seedDraft();
    const before = await sequenceRows();

    // 1 satang is never the priced total of a 12,000 THB plan.
    const stale = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `st-issue-stale-${invoiceId}`,
      invoiceId,
      expectedTotalSatang: '1',
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('issue_total_changed');

    expect(await sequenceRows()).toEqual(before);
    expect(await invoiceRow(invoiceId)).toEqual({
      status: 'draft',
      sequenceNumber: null,
      documentNumber: null,
    });

    // The admin refreshes and confirms again: the first number of the stream
    // is still free, so there is no gap.
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `st-issue-ok-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
    const row = await invoiceRow(invoiceId);
    expect(row?.status).toBe('issued');
    expect(row?.sequenceNumber).toBe(1);
  }, 60_000);
});

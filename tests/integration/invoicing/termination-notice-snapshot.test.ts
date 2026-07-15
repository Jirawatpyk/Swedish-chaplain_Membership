/**
 * 065 renewal-swecham-alignment (§5.4) — the statutory termination notice is
 * PINNED into the immutable `tenant_identity_snapshot` at issue (live Neon).
 *
 * Mirrors the WHT-note round-trip / bill-to-receipt harness: set the notice on
 * `tenant_invoice_settings`, draft + issue a membership ใบแจ้งหนี้ (bill), then
 * assert the issued invoice row's `tenant_identity_snapshot` carries the notice
 * text. `issue-invoice` copies `settings.identity` verbatim, so this proves the
 * new DB columns → `rowToView.identity` → snapshot chain end-to-end against real
 * Postgres (mocks hide the schema gap — see the F4 R8 gotcha).
 *
 * Bill-only RENDER (v12 / isBill) is covered separately by
 * termination-notice-scope; this file only proves the DATA pin.
 *
 * Migration 0256 MUST be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
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

const NOTICE_TH =
  'PLACEHOLDER: SweCham มีหน้าที่ตามระเบียบต้องยุติสมาชิกภาพของผู้ค้างชำระภายใน 60 วัน';
const NOTICE_EN =
  'PLACEHOLDER: SweCham is regulatory-bound to terminate members with unpaid fees.';

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_renderInput: PdfRenderInput) => ({
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

function issueDepsFlagOn(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
  };
}

describe('065 §5.4 — termination notice pinned into tenant_identity_snapshot (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'termination-notice-plan';
  const planYear = 2026;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    // Set the statutory notice directly on the settings row. `upsert`'s
    // copyFields does not carry these columns until Task 7, so the pin path is
    // exercised through a plain UPDATE + `getForIssue.identity` here.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(tenantInvoiceSettings)
        .set({ terminationNoticeTh: NOTICE_TH, terminationNoticeEn: NOTICE_EN })
        .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Termination Notice Plan' },
        description: { en: 'Plan for the 065 §5.4 snapshot-pin integration test' },
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
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Termination Notice Member Corp',
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
        firstName: 'Notice',
        lastName: 'Contact',
        email: 'notice.contact@tn.example',
        isPrimary: true,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('issues a membership bill whose tenant_identity_snapshot carries the notice text', async () => {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `tn-draft-${memberId}`,
      memberId,
      planId,
      planYear,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `tn-issue-${invoiceId}`,
      invoiceId,
    });
    expect(issued.ok, issued.ok ? 'ok' : `issue err: ${JSON.stringify(issued)}`).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('issued');
    // A non-tax ใบแจ้งหนี้ (bill) — the surface the notice will render on (Task 6).
    expect(row!.pdfDocKind).toBe('invoice');

    const snapshot = row!.tenantIdentitySnapshot as TenantIdentitySnapshot;
    expect(snapshot.termination_notice_th).toBe(NOTICE_TH);
    expect(snapshot.termination_notice_en).toBe(NOTICE_EN);
  }, 120_000);
});

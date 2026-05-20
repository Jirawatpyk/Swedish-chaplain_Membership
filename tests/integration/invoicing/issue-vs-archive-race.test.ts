/**
 * T099 — Issue-vs-archive race integration test (F4 / FR-037 R2-E2).
 *
 * Asserts the archive-race guard inside `issueInvoice`:
 *   1. The use-case locks the member row FOR UPDATE before allocating
 *      a sequence number (see issue-invoice.ts § B).
 *   2. If the member is archived at lock time, the use-case returns
 *      `member_archived` and the transaction rolls back BEFORE any
 *      sequence number is consumed — preserving Thai RD §87 no-gaps.
 *
 * This test seeds a draft invoice, archives the member, then calls
 * `issueInvoice` sequentially. The guard ordering means a truly
 * concurrent archive (arriving mid-flight) resolves to the same
 * terminal state because the FOR UPDATE lock on the member blocks
 * until the archive commits — so a sequential "archive-first, issue-
 * second" exercises the SAME code path the concurrent race hits.
 *
 * What this test proves:
 *   - `issueInvoice` returns `{ code: 'member_archived' }`.
 *   - `tenant_document_sequences` is unchanged (no gap introduced).
 *   - The draft invoice is untouched (no partial mutation).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

function makeDeps(tenantId: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
}

describe('F4 FR-037 — issue-vs-archive race guard (T099)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'arc-race-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Arc Race Plan' },
        description: { en: 'Test description' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'RCIT',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
      await tx
        .delete(tenantDocumentSequences)
        .where(eq(tenantDocumentSequences.tenantId, tenant.ctx.slug));
    });
  });

  it('issue on archived member returns member_archived and consumes NO sequence', async () => {
    const invoiceId = randomUUID();
    const memberId = randomUUID();

    // Seed draft + archived member
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Race Co',
        country: 'TH',
        planId,
        planYear: 2026,
        // Archive BEFORE issue — simulates the terminal state the
        // race-winner leaves behind. Either order of operations ends
        // here because the issue path locks the member FOR UPDATE.
        // DB CHECK `members_archived_at_iff_archived` requires both
        // `status='archived'` AND `archived_at IS NOT NULL` to be set
        // together — seeding one without the other is rejected.
        status: 'archived',
        archivedAt: new Date('2026-04-17T10:00:00Z'),
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        creditedTotalSatang: 0n,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 100_000n,
        totalSatang: 100_000n,
        position: 1,
      });
    });

    const r = await issueInvoice(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('member_archived');

    // Sequence table has NO row for (tenant, invoice, 2026) — the
    // archive guard runs BEFORE allocateNext, so no number was ever
    // consumed. FR-037 / Thai RD §87 no-gap invariant preserved.
    const seqRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'invoice'),
            eq(tenantDocumentSequences.fiscalYear, 2026),
          ),
        ),
    );
    expect(seqRows).toHaveLength(0);

    // Draft row untouched — still draft, no sequence number assigned.
    const [draftAfter] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          sequenceNumber: invoices.sequenceNumber,
          documentNumber: invoices.documentNumber,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(draftAfter?.status).toBe('draft');
    expect(draftAfter?.sequenceNumber).toBeNull();
    expect(draftAfter?.documentNumber).toBeNull();
  }, 60_000);
});

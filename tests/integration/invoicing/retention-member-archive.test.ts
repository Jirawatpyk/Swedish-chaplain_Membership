/**
 * T112 — Retention + member-archive invariant (FR-029 + FR-030).
 *
 * Thai Revenue Code §87/3 + GDPR Art. 6(1)(c) / PDPA §24 carve out a
 * legal-obligation retention for tax documents. Even when a member
 * requests erasure (archive / hard delete / right-to-be-forgotten),
 * the tenant MUST keep:
 *
 *   - the invoice / receipt / credit-note rows (FR-029, 10-year floor)
 *   - the frozen tenant+member identity snapshots (FR-030, legal record)
 *   - the US7 timeline enumerability for the archived member's history
 *
 * This test walks that invariant end-to-end on live Neon:
 *
 *   1. Seed a member + a paid invoice (full snapshots, PDF metadata).
 *   2. Archive the member via the F3 archive use-case.
 *   3. Assert:
 *      a. Member row flipped to status='archived' with archived_at set.
 *      b. Invoice row still exists in the DB (no cascade delete).
 *      c. Frozen `tenant_identity_snapshot` + `member_identity_snapshot`
 *         on the invoice are byte-identical to pre-archive.
 *      d. `listInvoicesByMember` still returns the archived member's
 *         invoices — timeline enumerability preserved for admin /
 *         legal-hold queries.
 *
 * What we are NOT testing here:
 *   - Hard-delete / GDPR-erasure behaviour (`member_hard_deleted` is a
 *     post-MVP feature not yet shipped).
 *   - PDF blob retention — the blob adapter is in-test a no-op, so
 *     bytes-at-rest is out of scope. The `pdf_blob_key` column on
 *     invoices is checked unchanged; Blob lifecycle is a separate
 *     operational concern (§ 7-year Vercel Blob retention policy).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
} from '@/modules/invoicing';
import { archiveMember, asMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

const TENANT_SNAP = {
  legal_name_th: 'ทดสอบ Retention',
  legal_name_en: 'Retention Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};

const MEMBER_SNAP = {
  legal_name: 'Retention Co (pre-archive)',
  tax_id: '1234567890123',
  address: '99/1 Sukhumvit Rd, Bangkok',
  primary_contact_name: 'Somchai',
  primary_contact_email: 'somchai@retention.test',
};

describe('T112 — FR-029/FR-030 retention + member-archive invariant (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 't112-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T112 Plan' },
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
        legalNameTh: TENANT_SNAP.legal_name_th,
        legalNameEn: TENANT_SNAP.legal_name_en,
        taxId: TENANT_SNAP.tax_id,
        registeredAddressTh: TENANT_SNAP.address_th,
        registeredAddressEn: TENANT_SNAP.address_en,
        invoiceNumberPrefix: 'T112',
        creditNoteNumberPrefix: 'T112C',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('archiving a member preserves: invoice row, frozen snapshots, timeline enumerability', async () => {
    const memberId = randomUUID();
    const invoiceId = randomUUID();

    // --- Seed: member + paid invoice with frozen snapshots ---
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Retention Co',
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
        sequenceNumber: 1,
        documentNumber: 'T112-2026-000001',
        issueDate: '2026-01-15',
        dueDate: '2026-02-14',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/t112/2026/retention.pdf',
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'T112-PAY-1',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-02-01',
        paidAt: new Date('2026-02-01T03:00:00Z'),
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

    // Capture pre-archive snapshot bytes so we can prove post-archive
    // equality byte-for-byte.
    const [before] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          tenantSnap: invoices.tenantIdentitySnapshot,
          memberSnap: invoices.memberIdentitySnapshot,
          pdfBlobKey: invoices.pdfBlobKey,
          pdfSha256: invoices.pdfSha256,
          docNum: invoices.documentNumber,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(before).toBeDefined();
    const preTenantSnap = JSON.stringify(before!.tenantSnap);
    const preMemberSnap = JSON.stringify(before!.memberSnap);
    const prePdfBlobKey = before!.pdfBlobKey;
    const prePdfSha256 = before!.pdfSha256;
    const preDocNum = before!.docNum;

    // --- (2) Archive the member ---
    const archiveResult = await archiveMember(
      asMemberId(memberId),
      { reason: 'Retention test — legal obligation check' },
      { actorUserId: user.userId, requestId: `t112-${invoiceId}` },
      buildMembersDeps(tenant.ctx),
    );
    expect(archiveResult.ok, 'archive must succeed').toBe(true);
    if (!archiveResult.ok) return;

    // --- (3a) Member row flipped but NOT deleted ---
    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(memberRows, 'member row must still exist post-archive').toHaveLength(1);
    expect(memberRows[0]!.status).toBe('archived');
    expect(memberRows[0]!.archivedAt).not.toBeNull();

    // --- (3b) FR-029: invoice row still present ---
    const invRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(invRows, 'FR-029: invoice row MUST NOT be deleted').toHaveLength(1);
    expect(invRows[0]!.status).toBe('paid'); // unchanged

    // --- (3c) FR-030: frozen snapshots + PDF metadata IDENTICAL ---
    const after = invRows[0]!;
    expect(
      JSON.stringify(after.tenantIdentitySnapshot),
      'FR-030: tenant_identity_snapshot must be byte-identical',
    ).toBe(preTenantSnap);
    expect(
      JSON.stringify(after.memberIdentitySnapshot),
      'FR-030: member_identity_snapshot must be byte-identical — the LEGAL record',
    ).toBe(preMemberSnap);
    expect(after.pdfBlobKey, 'pdf_blob_key unchanged').toBe(prePdfBlobKey);
    expect(after.pdfSha256, 'pdf_sha256 unchanged').toBe(prePdfSha256);
    expect(after.documentNumber, 'document_number unchanged').toBe(preDocNum);

    // --- (3d) US7 timeline enumerability preserved ---
    const listResult = await listInvoicesByMember(
      makeListInvoicesByMemberDeps(tenant.ctx.slug),
      { tenantId: tenant.ctx.slug, memberId, offset: 0, pageSize: 100 },
    );
    expect(listResult.ok, 'listInvoicesByMember must succeed for archived member').toBe(
      true,
    );
    if (!listResult.ok) return;
    expect(
      listResult.value.rows.length,
      'timeline must still enumerate the archived member\u2019s invoices',
    ).toBeGreaterThanOrEqual(1);
    const listed = listResult.value.rows.find(
      (r) => r.invoiceId === invoiceId,
    );
    expect(listed, 'the specific paid invoice must be in the timeline').toBeDefined();
    expect(listed!.memberIdentitySnapshot?.legal_name).toBe(MEMBER_SNAP.legal_name);
  }, 60_000);

  // Constitution v1.4.0 Principle I — two-layer tenant isolation
  // Review-Gate blocker. The archive + retention invariants above must
  // not leak across tenants: a second tenant's `listInvoicesByMember`
  // must return ZERO rows for tenant-A's member after archive, even
  // though the invoice row persists by legal obligation. This probes
  // both the application-layer `tenantId` scope AND the DB-layer RLS
  // FORCE policy.
  it('cross-tenant probe: tenant B cannot enumerate tenant A\u2019s archived invoices', async () => {
    const memberId = randomUUID();
    const invoiceId = randomUUID();

    // Seed + archive on tenant A (reusing the primary `tenant`).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Retention Co (probe)',
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
        sequenceNumber: 2,
        documentNumber: 'T112-2026-000002',
        issueDate: '2026-01-20',
        dueDate: '2026-02-19',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/t112/2026/retention-probe.pdf',
        pdfSha256: 'd'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'T112-PAY-2',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-02-05',
        paidAt: new Date('2026-02-05T03:00:00Z'),
      });
    });
    const archive = await archiveMember(
      asMemberId(memberId),
      { reason: 'cross-tenant probe seed' },
      { actorUserId: user.userId, requestId: `t112-probe-${invoiceId}` },
      buildMembersDeps(tenant.ctx),
    );
    expect(archive.ok).toBe(true);

    // Create tenant B and attempt to list tenant A's member via its
    // tenant context. RLS + application-layer scope must both prevent
    // the leak. Cleanup is registered via afterAll of the parent
    // describe, but the probe tenant is independent — clean on the
    // way out.
    const tenantB = await createTestTenant('test-swecham');
    try {
      const listResult = await listInvoicesByMember(
        makeListInvoicesByMemberDeps(tenantB.ctx.slug),
        {
          tenantId: tenantB.ctx.slug,
          memberId, // tenant A's member id, probed from tenant B
          offset: 0,
          pageSize: 100,
        },
      );
      expect(
        listResult.ok,
        'cross-tenant list must succeed (empty), not throw',
      ).toBe(true);
      if (!listResult.ok) return;
      expect(
        listResult.value.rows,
        'Principle I: tenant B MUST NOT see tenant A\u2019s invoices',
      ).toHaveLength(0);
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  }, 60_000);
});

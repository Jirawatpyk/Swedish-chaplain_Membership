/**
 * Round-3 invoice+receipt importer — live-Neon integration (Part 2 of the
 * Round-3 import; docs/import/ROUND3_PLAN.md § Invoice import).
 *
 * Drives `runInvoiceImport` (scripts/import-round3/invoice-import-core.ts) —
 * the SAME orchestration the operator CLI wraps — against a throwaway test
 * tenant on the dev Neon branch, through the REAL use-cases: createInvoiceDraft
 * → issueInvoice (per-doc backdated ClockPort → SC bill number + fiscal year)
 * → recordPayment 'admin_offline_mark' (RC receipt at FY(paymentDate)) /
 * voidInvoice, plus createCycleInTx + reanchorPeriodInTx / linkInvoice.
 *
 * SYNTHETIC fixture only (never real company names — PII rule): 5 docs across
 * 5 members: paid-coverage-future · paid-coverage-ended · issued · void ·
 * inactive-member issued.
 *
 * SUBSTITUTION (documented): ONLY the Blob adapter is replaced via the
 * `overrides.blob` seam (the PR #280 `InvoicingAdapterOverrides` contract) —
 * the dev env has no live Vercel Blob store (the nightly renewals sweep fails
 * on "This store does not exist"), and every invoicing integration suite
 * already injects its own double (see bill-to-receipt.integration.test.ts).
 * PDF RENDERING IS REAL (@react-pdf + Sarabun from process.cwd()).
 *
 * Run this ONE file positionally (never the bare suite):
 *   pnpm test:integration tests/integration/scripts/import-round3-invoices.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import type { BlobStoragePort } from '@/modules/invoicing/application/ports/blob-storage-port';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import type { Round3InvoiceDoc } from '@/../scripts/import-round3/finalized-sheet';

const { runInvoiceImport } = await import('@/../scripts/import-round3/invoice-import-core');

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

const PLAN_ID = 'r3-test-plan';
const PLAN_LABEL = 'R3 Test Plan';

/** Blob double — the ONLY substituted adapter (see file docstring). */
function makeBlobDouble(uploadedKeys: string[]): BlobStoragePort {
  return {
    uploadPdf: async ({ key }) => {
      uploadedKeys.push(key);
      return { key, url: `https://blob.test/${key}` };
    },
    uploadLogo: async ({ key }) => ({ key, url: `https://blob.test/${key}` }),
    signDownloadUrl: async (key) => `https://blob.test/${key}`,
    downloadBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    delete: async () => {},
    list: async () => [],
  };
}

interface Fixture {
  readonly memberId: string;
  readonly email: string;
  readonly active: boolean;
  readonly doc: Round3InvoiceDoc;
}

function mkDoc(over: Partial<Round3InvoiceDoc> & { contactEmail: string; rowIndex: number }): Round3InvoiceDoc {
  return {
    companyKey: `R3 SYNTH CO ${over.rowIndex}`,
    series: '2026',
    origBillNo: `MB2026-${String(over.rowIndex).padStart(3, '0')}`,
    origReceiptNo: null,
    issueDate: '2026-03-01',
    dueDateExcel: '2026-03-31',
    paymentDate: null,
    amountThb: 16000,
    vatThb: 1120,
    totalThb: 17120,
    targetStatus: 'issued',
    planTier: PLAN_LABEL,
    planYear: 2026,
    ...over,
  };
}

describe('Round-3 invoice import — end-to-end money path (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let fixtures: Record<'paidFuture' | 'paidEnded' | 'issued' | 'voided' | 'inactiveIssued', Fixture>;
  const uploadedKeys: string[] = [];

  const importInput = () => ({
    ctx: tenant.ctx,
    docs: Object.values(fixtures).map((f) => f.doc),
    resolvePlanId: (label: string) => (label === PLAN_LABEL ? PLAN_ID : null),
    commit: true,
    actorUserId: user.userId as string,
    overrides: { blob: makeBlobDouble(uploadedKeys) },
    // Pinned run instant → deterministic todayBangkok for the date guards +
    // operator-attention lists, forever (the fixture dates are historical).
    nowIso: '2026-07-29T04:00:00.000Z',
  });

  const memberNumberOf = async (memberId: string): Promise<number> =>
    db
      .select({ n: members.memberNumber })
      .from(members)
      .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId)))
      .then((r) => r[0]!.n);

  const invoiceRows = async () =>
    db
      .select()
      .from(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug));

  const cycleRows = async () =>
    db
      .select()
      .from(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug));

  const auditCount = async (eventType: string) =>
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, eventType as never),
        ),
      )
      .then((r) => r.length);

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // SweCham cutover fiscal config: SC bill prefix + RC receipt prefix.
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าทดสอบ',
      legalNameEn: 'R3 Test Chamber',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    // Plan catalogue for BOTH billed fiscal years (invoices_plan_fk is
    // (tenant, plan_id, plan_year) RESTRICT; the cycle freeze also resolves
    // by FY(period_from)).
    await runInTenant(tenant.ctx, async (tx) => {
      for (const planYear of [2025, 2026]) {
        await tx.insert(membershipPlans).values({
          tenantId: tenant.ctx.slug,
          planId: PLAN_ID,
          planYear,
          planName: { en: PLAN_LABEL },
          description: { en: 'Round-3 import integration plan' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_600_000, // 16,000 THB — matches the docs
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
    });

    // 5 synthetic members + primary contacts (mockup-style emails = join key).
    const mk = async (
      tag: string,
      active: boolean,
      planYear: number,
    ): Promise<{ memberId: string; email: string }> => {
      const memberId = randomUUID();
      const email = `r3-${tag}-${randomUUID().slice(0, 8)}@import.test`;
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `R3 Synth ${tag} Co`,
          country: 'TH',
          taxId: null,
          addressLine1: '1 Synthetic Test Road',
          city: 'Watthana',
          province: 'Bangkok',
          postalCode: '10110',
          planId: PLAN_ID,
          planYear,
          status: active ? 'active' : 'inactive',
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'R3',
          lastName: tag,
          email,
          isPrimary: true,
        });
      });
      return { memberId, email };
    };

    const paidFuture = await mk('paidfuture', true, 2026);
    const paidEnded = await mk('paidended', true, 2025);
    const issued = await mk('issued', true, 2026);
    const voided = await mk('void', true, 2026);
    const inactiveIssued = await mk('inactive', false, 2026);

    fixtures = {
      // Coverage [2026-03-01, 2027-03-01) — still running.
      paidFuture: {
        ...paidFuture,
        active: true,
        doc: mkDoc({
          contactEmail: paidFuture.email,
          rowIndex: 10,
          targetStatus: 'paid',
          issueDate: '2026-03-01',
          paymentDate: '2026-03-05',
          origReceiptNo: 'RC2026-010',
        }),
      },
      // Coverage [2025-06-10, 2026-06-10) — already ended → COLLECT list.
      paidEnded: {
        ...paidEnded,
        active: true,
        doc: mkDoc({
          contactEmail: paidEnded.email,
          rowIndex: 11,
          series: '2025',
          origBillNo: 'MB2025-011',
          origReceiptNo: 'RC2025-011',
          targetStatus: 'paid',
          issueDate: '2025-06-10',
          dueDateExcel: '2025-07-10',
          paymentDate: '2025-06-15',
          planYear: 2025,
        }),
      },
      issued: {
        ...issued,
        active: true,
        doc: mkDoc({
          contactEmail: issued.email,
          rowIndex: 12,
          targetStatus: 'issued',
          issueDate: '2026-07-01',
          dueDateExcel: '2026-07-31',
        }),
      },
      voided: {
        ...voided,
        active: true,
        doc: mkDoc({
          contactEmail: voided.email,
          rowIndex: 13,
          targetStatus: 'void',
          issueDate: '2026-05-01',
          origBillNo: 'MB2026-013',
        }),
      },
      inactiveIssued: {
        ...inactiveIssued,
        active: false,
        doc: mkDoc({
          contactEmail: inactiveIssued.email,
          rowIndex: 14,
          targetStatus: 'issued',
          issueDate: '2026-06-01',
          dueDateExcel: '2026-06-30',
        }),
      },
    };
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('imports all 5 docs — statuses, backdated dates, coverage, SC/RC numbers, money, cycles, audit', async () => {
    const { report } = await runInvoiceImport(importInput());

    expect(report.totals.errors, JSON.stringify(report.errors)).toBe(0);
    expect(report.totals.imported).toBe(5);
    expect(report.mode).toBe('commit');

    const rows = await invoiceRows();
    expect(rows).toHaveLength(5);
    const byMember = new Map(rows.map((r) => [r.memberId, r]));

    // --- paid, coverage in the future ------------------------------------
    const pf = byMember.get(fixtures.paidFuture.memberId)!;
    expect(pf.status).toBe('paid');
    expect(pf.invoiceSubject).toBe('membership');
    expect(pf.planId).toBe(PLAN_ID);
    expect(pf.planYear).toBe(2026);
    expect(pf.fiscalYear).toBe(2026);
    expect(pf.issueDate).toBe('2026-03-01');
    // System due = issue + netDays snapshot (the sheet's own due date is
    // report-only — the operator brief calls this out).
    expect(pf.netDaysSnapshot).not.toBeNull();
    expect(pf.paymentDate).toBe('2026-03-05');
    expect(pf.paymentMethod).toBe('bank_transfer');
    expect(pf.paymentReference).toBe('TSCC MB2026-010 / RC2026-010');
    // New-flow bill: SC raw number, §87 seq/doc NULL; RC minted at payment.
    expect(pf.billDocumentNumberRaw).toBe('SC-2026-000001');
    expect(pf.receiptDocumentNumberRaw).toBe('RC-2026-000001');
    expect(pf.sequenceNumber).toBeNull();
    expect(pf.documentNumber).toBeNull();
    // renewalSignal money: subtotal = sheet amount (VAT-exclusive), VAT 7%.
    expect(pf.subtotalSatang).toBe(1_600_000n);
    expect(pf.vatSatang).toBe(112_000n);
    expect(pf.totalSatang).toBe(1_712_000n);
    // True half-open coverage window persisted (mig 0281 guard armed).
    expect(pf.coverageFrom?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(pf.coverageTo?.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(pf.blocksCoverage).toBe(true);
    // Synchronous receipt render (asyncReceiptPdf pinned false).
    expect(pf.receiptPdfStatus).toBe('rendered');
    expect(pf.receiptPdfBlobKey).toBeTruthy();
    expect(pf.pdfBlobKey).toBeTruthy();

    // --- paid, coverage already ended ------------------------------------
    const pe = byMember.get(fixtures.paidEnded.memberId)!;
    expect(pe.status).toBe('paid');
    expect(pe.planYear).toBe(2025);
    expect(pe.fiscalYear).toBe(2025);
    expect(pe.issueDate).toBe('2025-06-10');
    expect(pe.paymentDate).toBe('2025-06-15');
    // FY comes from the backdated clock (bill) / payment date (receipt).
    expect(pe.billDocumentNumberRaw).toBe('SC-2025-000001');
    expect(pe.receiptDocumentNumberRaw).toBe('RC-2025-000001');
    expect(pe.coverageFrom?.toISOString()).toBe('2025-06-10T00:00:00.000Z');
    expect(pe.coverageTo?.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(pe.receiptPdfStatus).toBe('rendered');

    // --- issued (stays issued) -------------------------------------------
    const is = byMember.get(fixtures.issued.memberId)!;
    expect(is.status).toBe('issued');
    expect(is.issueDate).toBe('2026-07-01');
    expect(is.billDocumentNumberRaw).toBe('SC-2026-000004');
    expect(is.receiptDocumentNumberRaw).toBeNull();
    expect(is.paymentDate).toBeNull();
    expect(is.blocksCoverage).toBe(true);

    // --- void (issue-then-void; number kept, coverage guard DISARMED) -----
    const vd = byMember.get(fixtures.voided.memberId)!;
    expect(vd.status).toBe('void');
    expect(vd.billDocumentNumberRaw).toBe('SC-2026-000002');
    expect(vd.voidReason).toBe('Cancelled per TSCC records (import; original MB2026-013)');
    expect(vd.voidedByUserId).toBe(user.userId);
    expect(vd.voidedAt).not.toBeNull();
    expect(vd.blocksCoverage).toBe(false); // void never blocks the EXCLUDE

    // --- inactive member, issued ------------------------------------------
    const ii = byMember.get(fixtures.inactiveIssued.memberId)!;
    expect(ii.status).toBe('issued');
    expect(ii.billDocumentNumberRaw).toBe('SC-2026-000003');

    // --- report: mapping table + operator attention -----------------------
    expect(report.mintedNumberMap).toContainEqual([
      10,
      'MB2026-010',
      'RC2026-010',
      'SC-2026-000001',
      'RC-2026-000001',
      await memberNumberOf(fixtures.paidFuture.memberId),
    ]);
    expect(report.operatorAttention.paidCoverageEnded).toEqual([
      { rowIndex: 11, coverageTo: '2026-06-10' },
    ]);
    expect(report.operatorAttention.issuedInactiveMember).toEqual([{ rowIndex: 14 }]);

    // --- cycles ------------------------------------------------------------
    const cycles = await cycleRows();
    expect(cycles).toHaveLength(3); // paid ×2 + issued(active); void + inactive get none
    const cByMember = new Map(cycles.map((c) => [c.memberId, c]));

    const cPf = cByMember.get(fixtures.paidFuture.memberId)!;
    expect(cPf.status).toBe('upcoming');
    expect(cPf.periodFrom.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(cPf.periodTo.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(cPf.anchoredAt?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    expect(cPf.anchorInvoiceId).toBe(pf.invoiceId);
    expect(cPf.linkedInvoiceId).toBeNull(); // anchor invoice NEVER occupies linked
    expect(cPf.frozenPlanPriceThb).toBe('16000.00');

    const cPe = cByMember.get(fixtures.paidEnded.memberId)!;
    expect(cPe.status).toBe('upcoming');
    expect(cPe.periodFrom.toISOString()).toBe('2025-06-10T00:00:00.000Z');
    expect(cPe.periodTo.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(cPe.anchoredAt?.toISOString()).toBe('2025-06-15T00:00:00.000Z');
    expect(cPe.anchorInvoiceId).toBe(pe.invoiceId);
    expect(cPe.linkedInvoiceId).toBeNull();

    const cIs = cByMember.get(fixtures.issued.memberId)!;
    expect(cIs.status).toBe('awaiting_payment');
    expect(cIs.periodFrom.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(cIs.periodTo.toISOString()).toBe('2027-07-01T00:00:00.000Z');
    expect(cIs.anchoredAt).toBeNull();
    expect(cIs.linkedInvoiceId).toBe(is.invoiceId);

    expect(cByMember.has(fixtures.voided.memberId)).toBe(false);
    expect(cByMember.has(fixtures.inactiveIssued.memberId)).toBe(false);

    // The F8 on-paid callback join resolves the linked bill → cycle.
    const repo = makeDrizzleRenewalCycleRepo(tenant.ctx);
    const resolved = await runInTenant(tenant.ctx, (tx) =>
      repo.findByInvoiceIdInTx(tx, tenant.ctx.slug, is.invoiceId),
    );
    expect(resolved?.cycleId).toBe(cIs.cycleId);

    // --- audit -------------------------------------------------------------
    expect(await auditCount('invoice_issued')).toBe(5);
    expect(await auditCount('invoice_paid')).toBe(2);
    expect(await auditCount('tax_receipt_issued')).toBe(2);
    expect(await auditCount('invoice_voided')).toBe(1);
    expect(await auditCount('renewal_cycle_created')).toBe(3);
    expect(await auditCount('renewal_cycle_reanchored')).toBe(2);
  }, 240_000);

  it('re-run is idempotent — zero new rows, cycles no-op via findActiveForMemberInTx', async () => {
    const before = {
      invoices: (await invoiceRows()).length,
      cycles: (await cycleRows()).length,
      issuedAudit: await auditCount('invoice_issued'),
      paidAudit: await auditCount('invoice_paid'),
    };

    const { report } = await runInvoiceImport(importInput());

    expect(report.totals.errors, JSON.stringify(report.errors)).toBe(0);
    expect(report.totals.imported).toBe(0);
    expect(report.totals.resumed).toBe(0);
    expect(report.totals.skippedAlreadyImported).toBe(5);
    expect(report.cycles.skippedActiveExists).toBe(3);
    expect(report.cycles.noneVoid).toBe(1);
    expect(report.cycles.noneInactiveMember).toBe(1);
    // The mapping table stays complete on a re-run (numbers read from the DB).
    expect(report.mintedNumberMap.map((r) => r[3])).toEqual([
      'SC-2026-000001',
      'SC-2025-000001',
      'SC-2026-000004',
      'SC-2026-000002',
      'SC-2026-000003',
    ]);

    expect((await invoiceRows()).length).toBe(before.invoices);
    expect((await cycleRows()).length).toBe(before.cycles);
    expect(await auditCount('invoice_issued')).toBe(before.issuedAudit);
    expect(await auditCount('invoice_paid')).toBe(before.paidAudit);
  }, 120_000);
});

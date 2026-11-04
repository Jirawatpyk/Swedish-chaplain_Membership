/**
 * #729 (task 63) — the orphan PDF sweeper against live Neon.
 *
 * The real invoice repo and the real lock-free reference read (RLS + the
 * explicit tenant predicate) with an in-memory Blob store. A key is kept iff the row it names references
 * exactly that key; each tenant's sweep lists only its own folder, so it can
 * never read or delete another tenant's PDFs (Principle I).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { makeDrizzleInvoiceRepo, makeDrizzleOrphanPdfReferenceRepo } from '@/modules/invoicing';
import {
  ORPHAN_PDF_MIN_AGE_MS,
  sweepOrphanPdfs,
} from '@/modules/invoicing/application/use-cases/sweep-orphan-pdfs';
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

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const FISCAL_YEAR = 2026;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Orphan Sweep Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/** A `paid` membership invoice paid by bank transfer (no online payment to guard). */
/** A distinct sequence per seeded invoice: `invoices_tenant_fiscal_seq_unique` (R123). */
let seedSequence = 0;

async function seedPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  invoiceId: string,
  keys: { pdf: string; receipt: string | null },
  receiptPdfStatus: 'pending' | 'rendered' = 'rendered',
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Orphan Sweep Co',
      country: 'TH',
      planId,
      planYear: FISCAL_YEAR,
    });
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: FISCAL_YEAR,
      planId,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      receiptPdfStatus,
      fiscalYear: FISCAL_YEAR,
      sequenceNumber: ++seedSequence,
      documentNumber: `OPS-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
      issueDate: '2026-04-15',
      dueDate: '2026-05-14',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: keys.pdf,
      receiptPdfBlobKey: keys.receipt,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentNotes: null,
      paymentRecordedByUserId: user.userId,
      paymentDate: '2026-04-20',
      paidAt: new Date('2026-04-20T03:00:00Z'),
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return invoiceId;
}

async function setUpTenant(user: TestUser, planId: string): Promise<TestTenant> {
  const tenant = await createTestTenant('test-chamber');
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: FISCAL_YEAR,
      planName: { en: 'Orphan Sweep Plan' },
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
      registrationFeeSatang: asSatang(0n),
      legalNameTh: 'ทดสอบ',
      legalNameEn: 'Test',
      taxId: '0000000000000',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'OPS',
      creditNoteNumberPrefix: 'CN',
    });
  });
  return tenant;
}


const referencedKeys = (tenantId: string, ids: { invoiceIds: readonly string[]; creditNoteIds: readonly string[] }) =>
  runInTenant(asTenantContext(tenantId), (tx) => makeDrizzleOrphanPdfReferenceRepo(tx).referencedKeys(tenantId, ids));

function memoryBlob(keys: string[]) {
  const old = new Date(Date.now() - ORPHAN_PDF_MIN_AGE_MS - 60_000);
  const store = new Map(keys.map((k) => [k, { key: k, uploadedAt: old, etag: `e-${k}` }]));
  const prefixes: string[] = [];
  return {
    store,
    prefixes,
    port: {
      listPage: async (prefix: string) => {
        prefixes.push(prefix);
        return { items: [...store.values()].filter((i) => i.key.startsWith(prefix)), cursor: undefined, hasMore: false };
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  };
}

describe('#729 — orphan PDF sweeper (live Neon)', () => {
  let user: TestUser;
  let a: TestTenant;
  let b: TestTenant;
  const planId = 'orphan-sweep-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    a = await setUpTenant(user, planId);
    b = await setUpTenant(user, planId);
  }, 90_000);

  afterAll(async () => {
    await a.cleanup().catch(() => {});
    await b.cleanup().catch(() => {});
  });

  const k = (t: TestTenant, name: string) => `invoicing/${t.ctx.slug}/${FISCAL_YEAR}/${name}`;

  it('keeps every referenced key, deletes the orphans, and never leaves its tenant folder', async () => {
    const paid = randomUUID();
    const voided = randomUUID();
    const other = randomUUID();
    const rendering = randomUUID();
    await seedPaidInvoice(a, user, planId, paid, {
      pdf: k(a, `${paid}_v12.pdf`),
      receipt: k(a, `${paid}_receipt_v12.pdf`),
    });
    // (c) a row with an invoice PDF but no receipt: its receipt key is an orphan.
    await seedPaidInvoice(a, user, planId, voided, { pdf: k(a, `${voided}_v13.pdf`), receipt: null });
    await seedPaidInvoice(b, user, planId, other, { pdf: k(b, `${other}_v13.pdf`), receipt: null });
    // Financial H-1: the async receipt worker has uploaded but not yet written
    // the key (paid, receipt pending). Its bytes are kept.
    await seedPaidInvoice(a, user, planId, rendering, { pdf: k(a, `${rendering}_v13.pdf`), receipt: null }, 'pending');

    const blob = memoryBlob([
      k(a, `${paid}_v12.pdf`), // referenced
      k(a, `${paid}_receipt_v12.pdf`), // referenced (an older template version)
      k(a, `${paid}_receipt_v13.pdf`), // (d) the bumped retry nobody references
      k(a, `${voided}_v13.pdf`), // referenced
      k(a, `${rendering}_v13.pdf`), // referenced
      k(a, `${rendering}_receipt_v13.pdf`), // the worker's in-flight receipt: kept
      k(a, `${voided}_receipt_v13.pdf`), // (c) orphan
      k(a, `${randomUUID()}_v13.pdf`), // (a) no row at all
      k(a, `credit-note_${randomUUID()}_v13.pdf`), // credit note with no row
      `invoicing/${a.ctx.slug}/logos/logo.png`, // never touched
      k(b, `${other}_v13.pdf`), // tenant B, referenced
      k(b, `${randomUUID()}_receipt_v13.pdf`), // tenant B orphan
    ]);
    const before = new Set(blob.store.keys());

    const r = await sweepOrphanPdfs(
      {},
      {
        blob: blob.port,
        clock: { nowIso: () => new Date().toISOString() },
        listTenantIds: async () => [a.ctx.slug],
        referencedKeys,
        reposFor: (tenantId) => ({ invoiceRepo: makeDrizzleInvoiceRepo(tenantId) }),
      },
    );

    expect(r).toMatchObject({ kind: 'ok', deleted: 4, kept: 5, skippedUnknown: 1, failed: 0 });
    expect(blob.prefixes).toEqual([`invoicing/${a.ctx.slug}/`]);
    const left = new Set(blob.store.keys());
    for (const kept of [
      k(a, `${paid}_v12.pdf`),
      k(a, `${paid}_receipt_v12.pdf`),
      k(a, `${voided}_v13.pdf`),
      k(a, `${rendering}_v13.pdf`),
      k(a, `${rendering}_receipt_v13.pdf`),
      `invoicing/${a.ctx.slug}/logos/logo.png`,
    ]) {
      expect(left.has(kept), kept).toBe(true);
    }
    expect(left.has(k(a, `${paid}_receipt_v13.pdf`))).toBe(false);
    expect(left.has(k(a, `${voided}_receipt_v13.pdf`))).toBe(false);
    // Tenant B's folder was never listed, so both its keys are untouched.
    for (const key of before) if (key.startsWith(`invoicing/${b.ctx.slug}/`)) expect(left.has(key)).toBe(true);
  }, 60_000);

  it('a tenant cannot see another tenant\'s row: A\'s repos read B\'s invoice as missing (RLS + predicate)', async () => {
    const id = randomUUID();
    await seedPaidInvoice(b, user, planId, id, { pdf: k(b, `${id}_v13.pdf`), receipt: null });
    // The lock-free read: A asking for B's id finds no reference.
    expect([...(await referencedKeys(a.ctx.slug, { invoiceIds: [id], creditNoteIds: [] }))]).toEqual([]);
    expect([...(await referencedKeys(b.ctx.slug, { invoiceIds: [id], creditNoteIds: [] }))]).toEqual([
      k(b, `${id}_v13.pdf`),
    ]);
    const repo = makeDrizzleInvoiceRepo(a.ctx.slug);
    const seen = await repo.withTx((tx) => repo.findByIdInTxForUpdate(tx, id as never, a.ctx.slug));
    expect(seen).toBeNull();
    const own = makeDrizzleInvoiceRepo(b.ctx.slug);
    const mine = await own.withTx((tx) => own.findByIdInTxForUpdate(tx, id as never, b.ctx.slug));
    expect(mine?.pdf?.blobKey).toBe(k(b, `${id}_v13.pdf`));
  }, 60_000);
});

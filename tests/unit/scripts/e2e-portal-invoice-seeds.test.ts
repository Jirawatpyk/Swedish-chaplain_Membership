/**
 * The e2e portal-invoice fixture rows (`scripts/seed-e2e-portal-invoices.ts`).
 *
 * The paid fixtures SC-2026-900001/2 used to be seeded in the legacy pre-088
 * combined-mode shape (§87 number in `document_number`, no bill number, no RC,
 * receipt `pending` forever). Production has no such rows (prod query
 * 2026-09-28: 0 of 99 receipt-bearing invoices) and the 088 flag is on
 * everywhere, so the dev review of spec 122 US4 hit a state prod cannot reach.
 * These cases pin the paid fixtures to the real 088 paid-bill shape that
 * `issueInvoice` + `recordPayment` write, and check the invoices CHECK
 * constraints a paid 088 row must satisfy.
 */
import { describe, expect, it } from 'vitest';
import { isKnownTemplateVersion } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { memberIdentitySnapshotSchema } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import {
  E2E_PAID_TEMPLATE_VERSION,
  E2E_PORTAL_INVOICE_SEEDS,
  buildE2ePortalInvoiceRow,
  fixtureNeedsReseed,
  mainPdfBlobKey,
  receiptPdfBlobKey,
  type E2ePortalInvoiceSeed,
} from '../../../scripts/lib/e2e-portal-invoice-seeds';

const TENANT = 'swecham';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
const RECEIPT_SHA = 'b'.repeat(64);

function seed(number: string): E2ePortalInvoiceSeed {
  const s = E2E_PORTAL_INVOICE_SEEDS.find((x) => x.number === number);
  if (!s) throw new Error(`no seed ${number}`);
  return s;
}

function build(s: E2ePortalInvoiceSeed) {
  return buildE2ePortalInvoiceRow({
    seed: s,
    tenantSlug: TENANT,
    memberId: MEMBER_ID,
    adminUserId: ADMIN_ID,
    mainPdf: { blobKey: mainPdfBlobKey(TENANT, s), sha256: SHA },
    receiptPdf:
      s.status === 'paid'
        ? { blobKey: receiptPdfBlobKey(TENANT, s), sha256: RECEIPT_SHA }
        : null,
  });
}

describe('E2E_PORTAL_INVOICE_SEEDS', () => {
  it('seeds 900001/2 paid and 900003 issued, each on a pinned invoice id', () => {
    expect(E2E_PORTAL_INVOICE_SEEDS.map((s) => [s.number, s.status, s.invoiceId])).toEqual([
      ['SC-2026-900001', 'paid', '00000000-e2e0-4fff-9ffe-000000900001'],
      ['SC-2026-900002', 'paid', '00000000-e2e0-4fff-9ffe-000000900002'],
      ['SC-2026-900003', 'issued', '00000000-e2e0-4fff-9ffe-000000900003'],
    ]);
  });
});

describe('buildE2ePortalInvoiceRow — paid fixtures are real 088 paid bills', () => {
  it('renders at a registered template version (bill + receipt layout of 088)', () => {
    expect(isKnownTemplateVersion(E2E_PAID_TEMPLATE_VERSION)).toBe(true);
  });

  it.each(['SC-2026-900001', 'SC-2026-900002'])('%s carries the SC bill + RC numbers, no §87 invoice number', (n) => {
    const s = seed(n);
    const row = build(s);
    expect(row.status).toBe('paid');
    expect(row.billDocumentNumberRaw).toBe(n);
    expect(row.receiptDocumentNumberRaw).toBe(n.replace('SC-', 'RC-'));
    // 088 bill leg of invoices_non_draft_has_snapshots: bill raw set, §87 pair NULL.
    expect(row.sequenceNumber).toBeNull();
    expect(row.documentNumber).toBeNull();
    // The main blob stays the bill (pdf_doc_kind is immutable at 'invoice').
    expect(row.pdfDocKind).toBe('invoice');
    expect(row.invoiceId).toBe(s.invoiceId);
  });

  it('has a RENDERED receipt with its blob, and the payment fields recordPayment writes', () => {
    const s = seed('SC-2026-900001');
    const row = build(s);
    // invoices_paid_has_receipt_status + a downloadable receipt (never a
    // "generating" state with no outbox row to finish it).
    expect(row.receiptPdfStatus).toBe('rendered');
    expect(row.receiptPdfBlobKey).toBe(receiptPdfBlobKey(TENANT, s));
    expect(row.receiptPdfSha256).toBe(RECEIPT_SHA);
    expect(row.receiptPdfTemplateVersion).toBe(row.pdfTemplateVersion);
    // invoices_paid_has_payment.
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.paymentMethod).toBe('bank_transfer');
    expect(row.paymentDate).toBe('2026-04-18');
    expect(row.paymentRecordedByUserId).toBe(ADMIN_ID);
  });

  it('uses the production blob-key scheme for the bill and the receipt', () => {
    const s = seed('SC-2026-900002');
    expect(mainPdfBlobKey(TENANT, s)).toBe(
      `invoicing/swecham/2026/${s.invoiceId}_v${build(s).pdfTemplateVersion}.pdf`,
    );
    expect(receiptPdfBlobKey(TENANT, s)).toBe(
      `invoicing/swecham/2026/${s.invoiceId}_receipt_v${build(s).pdfTemplateVersion}.pdf`,
    );
  });

  it('keeps VAT arithmetic exact (subtotal + VAT = total)', () => {
    for (const s of E2E_PORTAL_INVOICE_SEEDS) {
      const row = build(s);
      expect((row.subtotalSatang as bigint) + (row.vatSatang as bigint)).toBe(s.totalSatang);
      expect(row.totalSatang).toBe(s.totalSatang);
    }
  });

  it('refuses to build a paid row without a receipt PDF', () => {
    const s = seed('SC-2026-900001');
    expect(() =>
      buildE2ePortalInvoiceRow({
        seed: s,
        tenantSlug: TENANT,
        memberId: MEMBER_ID,
        adminUserId: ADMIN_ID,
        mainPdf: { blobKey: mainPdfBlobKey(TENANT, s), sha256: SHA },
        receiptPdf: null,
      }),
    ).toThrow(/receipt/);
  });
});

describe('buildE2ePortalInvoiceRow — the issued fixture is an unpaid 088 bill', () => {
  // With FEATURE_088_TAX_AT_PAYMENT on, paying a legacy §87-numbered invoice is
  // refused (`legacy_invoice_needs_reissue`), so the pay-sheet fixture must be a
  // real 088 bill for the pay specs to pay it.
  it('SC-2026-900003 carries the SC bill number and no §87 number, RC, payment or receipt', () => {
    const s = seed('SC-2026-900003');
    const row = build(s);
    expect(row.status).toBe('issued');
    expect(row.billDocumentNumberRaw).toBe('SC-2026-900003');
    expect(row.documentNumber).toBeNull();
    expect(row.sequenceNumber).toBeNull();
    expect(row.receiptDocumentNumberRaw).toBeNull();
    expect(row.receiptPdfStatus).toBeNull();
    expect(row.paidAt).toBeNull();
    expect(row.paymentMethod).toBeNull();
    expect(row.pdfDocKind).toBe('invoice');
    expect(row.invoiceId).toBe(s.invoiceId);
  });

  it('renders the bill at the same template version + production key scheme as the paid fixtures', () => {
    const s = seed('SC-2026-900003');
    const row = build(s);
    expect(row.pdfTemplateVersion).toBe(E2E_PAID_TEMPLATE_VERSION);
    expect(mainPdfBlobKey(TENANT, s)).toBe(
      `invoicing/swecham/2026/${s.invoiceId}_v${E2E_PAID_TEMPLATE_VERSION}.pdf`,
    );
  });
});

/*
 * Every later document on a fixture (receipt at payment, credit note, void)
 * re-renders from the STORED snapshots. The tenant snapshot used to be
 * `{ legal_name_*, tax_id, address }`, so paying SC-2026-900003 in the app
 * crashed the receipt render on `tenant.address_th.split` (pdf_render_failed).
 * The jsonb column is untyped, so only these cases catch a wrong shape.
 */
describe('buildE2ePortalInvoiceRow — stored snapshots are the shapes the renderer reads', () => {
  it.each(E2E_PORTAL_INVOICE_SEEDS.map((s) => s.number))('%s stores a full tenant identity snapshot', (n) => {
    const snapshot = build(seed(n)).tenantIdentitySnapshot as Record<string, unknown>;
    for (const key of ['legal_name_th', 'legal_name_en', 'tax_id', 'address_th', 'address_en']) {
      expect(typeof snapshot[key], key).toBe('string');
      expect((snapshot[key] as string).length, key).toBeGreaterThan(0);
    }
    expect(snapshot.logo_blob_key).toBeNull();
    expect(snapshot).not.toHaveProperty('address');
  });

  it('stores a member snapshot the read boundary accepts', () => {
    const snapshot = build(seed('SC-2026-900003')).memberIdentitySnapshot;
    expect(memberIdentitySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

describe('fixtureNeedsReseed', () => {
  const good = buildE2ePortalInvoiceRow({
    seed: seed('SC-2026-900001'),
    tenantSlug: TENANT,
    memberId: MEMBER_ID,
    adminUserId: ADMIN_ID,
    mainPdf: { blobKey: 'k', sha256: SHA },
    receiptPdf: { blobKey: 'r', sha256: RECEIPT_SHA },
  }).tenantIdentitySnapshot;

  it('flags any old-shape fixture (§87 number, no bill number) for replacement — paid or issued', () => {
    expect(fixtureNeedsReseed({ documentNumber: 'SC-2026-900001', billDocumentNumberRaw: null, tenantIdentitySnapshot: good })).toBe(true);
    expect(fixtureNeedsReseed({ documentNumber: 'SC-2026-900003', billDocumentNumberRaw: null, tenantIdentitySnapshot: good })).toBe(true);
  });

  it('flags an 088 bill still carrying the old `{ address }` tenant snapshot', () => {
    const old = { legal_name_en: 'x', legal_name_th: 'x', tax_id: '0000000000000', address: 'Bangkok' };
    expect(fixtureNeedsReseed({ documentNumber: null, billDocumentNumberRaw: 'SC-2026-900003', tenantIdentitySnapshot: old })).toBe(true);
  });

  it('leaves an 088-shaped fixture with a full snapshot alone', () => {
    expect(fixtureNeedsReseed({ documentNumber: null, billDocumentNumberRaw: 'SC-2026-900001', tenantIdentitySnapshot: good })).toBe(false);
  });
});

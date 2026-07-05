/**
 * 090-fix-portal-receipt-download — Bug 3.
 *
 * The portal dashboard "Recent invoices" summary card previously rendered ONLY
 * the invoice/bill PDF download (`PortalInvoiceDownloadButton`, gated on
 * `r.pdf`), so a member who PAID saw no "Download receipt" (§86/4 RC) button —
 * inconsistent with the detail page + the full invoice list, which surface the
 * receipt download once the row is paid + its receipt PDF has rendered.
 *
 * This test renders the async server component directly (mirrors
 * invoices-summary-card-error.test.tsx) with the download buttons mocked to
 * sentinels, and asserts the card's per-row CHOICE: a paid+rendered row exposes
 * the RECEIPT download; an unpaid (issued) row does NOT. The flags come from the
 * shared `toInvoiceRowViewModel` single-source-of-truth (real, not mocked) so
 * this can never drift from the detail page / list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

import { asInvoiceId, type Invoice } from '@/modules/invoicing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';

// --- mocks -----------------------------------------------------------------

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

vi.mock('next-intl/server', () => ({
  // identity translator is enough — this test asserts WHICH download control
  // renders (by sentinel), not the copy (i18n parity is covered elsewhere).
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { memberId: 'm1' } }),
    },
  }),
}));

// Spread the REAL invoicing barrel (import-safe in unit tests — the card-list
// test loads it unmocked) and override ONLY the paged read so the card's
// `billFirstDocumentNumber` + `toInvoiceRowViewModel` deps stay real.
const listInvoicesPagedMock = vi.fn();
vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    listInvoicesPaged: (...args: unknown[]) => listInvoicesPagedMock(...args),
    makeListInvoicesDeps: () => ({ invoiceRepo: {} }),
  };
});

// Download buttons → sentinels that echo which variant the card chose.
vi.mock(
  '@/app/(member)/portal/invoices/_components/portal-pdf-download-button',
  () => ({
    PortalInvoiceDownloadButton: (props: { documentNumber: string }) => (
      <span data-testid="invoice-download">
        INVOICE_DOWNLOAD:{props.documentNumber}
      </span>
    ),
    PortalReceiptDownloadButton: (props: { documentNumber: string }) => (
      <span data-testid="receipt-download">
        RECEIPT_DOWNLOAD:{props.documentNumber}
      </span>
    ),
  }),
);

vi.mock(
  '@/app/(member)/portal/invoices/_components/invoice-status-badge',
  () => ({
    InvoiceStatusBadge: (props: { label: string }) => (
      <span data-testid="status-badge">{props.label}</span>
    ),
  }),
);

import { InvoicesSummaryCard } from '@/components/portal/invoices-summary-card';

// --- fixture ---------------------------------------------------------------

function sha(): Sha256Hex {
  const r = Sha256Hex.parse('a'.repeat(64));
  if (!r.ok) throw new Error('bad fixture hash');
  return r.value;
}
function docNum(): DocumentNumber {
  const r = DocumentNumber.parse('INV-2026-000001');
  if (!r.ok) throw new Error('bad fixture doc number');
  return r.value;
}

function buildInvoice(
  overrides: Partial<Extract<Invoice, { invoiceSubject: 'membership' }>> = {},
): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('11111111-2222-4333-8444-555555555555'),
    invoiceSubject: 'membership',
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    eventId: null,
    eventRegistrationId: null,
    vatInclusive: false,
    status: 'issued',
    draftByUserId: 'u',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_00n),
    total: Money.fromSatangUnsafe(107_00n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: makeTenantIdentitySnapshot({
      legal_name_th: 'x',
      legal_name_en: 'x',
      tax_id: '0',
      address_th: 'x',
      address_en: 'x',
      logo_blob_key: null,
    }),
    memberIdentitySnapshot: makeMemberIdentitySnapshot({
      legal_name: 'x',
      tax_id: null,
      address: 'x',
      primary_contact_name: 'x',
      primary_contact_email: 'contact@example.com',
    }),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: { blobKey: 'k', sha256: sha(), templateVersion: 1 },
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

async function renderCardWith(rows: Invoice[]): Promise<string> {
  listInvoicesPagedMock.mockResolvedValue({ ok: true, value: { rows } });
  const tree = await InvoicesSummaryCard({ user: { id: 'u1' as never } });
  return renderToStaticMarkup(tree as ReactElement);
}

describe('<InvoicesSummaryCard> — receipt download (090 Bug 3)', () => {
  beforeEach(() => {
    listInvoicesPagedMock.mockReset();
  });

  it('a PAID + receipt-rendered row exposes the §86/4 RECEIPT download', async () => {
    const paid = buildInvoice({
      status: 'paid',
      paidAt: '2026-04-05T00:00:00Z',
      receiptPdfStatus: 'rendered',
      receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
      receiptDocumentNumberRaw: 'RC-2026-000001',
    });
    const html = await renderCardWith([paid]);
    expect(html).toContain('RECEIPT_DOWNLOAD');
    // Still offers the invoice/bill PDF alongside (separate-mode: two docs).
    expect(html).toContain('INVOICE_DOWNLOAD');
  });

  it('an UNPAID (issued) row shows the invoice download but NO receipt download', async () => {
    const issued = buildInvoice({ status: 'issued' });
    const html = await renderCardWith([issued]);
    expect(html).toContain('INVOICE_DOWNLOAD');
    expect(html).not.toContain('RECEIPT_DOWNLOAD');
  });

  it('a PAID row whose receipt PDF is still PENDING does NOT yet show the receipt download', async () => {
    const pending = buildInvoice({
      status: 'paid',
      paidAt: '2026-04-05T00:00:00Z',
      receiptPdfStatus: 'pending',
      receiptPdf: null,
      receiptDocumentNumberRaw: 'RC-2026-000002',
    });
    const html = await renderCardWith([pending]);
    expect(html).not.toContain('RECEIPT_DOWNLOAD');
  });
});

/**
 * n20 regression guard — the invoice + credit-note API serialisers MUST NOT
 * surface internal Vercel Blob object keys (`invoicing/{tenantId}/{fy}/{uuid}`),
 * which expose infra/tenant structure. The fixtures below DELIBERATELY set
 * `blobKey` so the assertions prove the serialiser DROPS it even when present;
 * `pdf_sha256` (content-integrity hash) must still be surfaced.
 *
 * Pure presentation serialisers — no DB/framework, so this is a fast unit test.
 */
import { describe, expect, it } from 'vitest';
import { serialiseInvoice } from '@/app/api/invoices/_serialise';
import { serialiseCreditNote } from '@/app/api/credit-notes/_serialise';
import type { Invoice, CreditNote } from '@/modules/invoicing';

const PDF = { blobKey: 'invoicing/t-1/2026/inv_uuid_v1.pdf', sha256: 'sha-inv', templateVersion: 1 };
const RECEIPT_PDF = { blobKey: 'invoicing/t-1/2026/rcpt_uuid_v1.pdf', sha256: 'sha-rcpt', templateVersion: 1 };

const invoiceFixture = {
  tenantId: 't-1', invoiceId: 'inv-1', memberId: 'm-1', planId: 'p-1', planYear: 2026,
  status: 'paid', fiscalYear: 2026, sequenceNumber: 1,
  documentNumber: null, issueDate: null, dueDate: null, paidAt: null, voidedAt: null,
  currency: 'THB',
  subtotal: null, vatRate: null, vat: null, total: null,
  creditedTotal: { satang: 0n },
  pdf: PDF,
  receiptDocumentNumberRaw: null, receiptPdfStatus: 'combined',
  receiptPdf: RECEIPT_PDF,
  autoEmailOnIssue: false, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  lines: [],
} as unknown as Invoice;

const creditNoteFixture = {
  tenantId: 't-1', creditNoteId: 'cn-1', originalInvoiceId: 'inv-1',
  fiscalYear: 2026, sequenceNumber: 1, documentNumber: { raw: 'CN-2026-0001' },
  issueDate: new Date('2026-01-02'), issuedByUserId: 'u-1', reason: 'test',
  creditAmount: { satang: 0n }, vat: { satang: 0n }, total: { satang: 0n },
  pdf: { blobKey: 'invoicing/t-1/2026/cn_uuid_v1.pdf', sha256: 'sha-cn', templateVersion: 1 },
  createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-02'),
} as unknown as CreditNote;

describe('n20 — serialisers do not leak internal blob keys', () => {
  it('serialiseInvoice omits pdf_blob_key + receipt_pdf_blob_key (keeps pdf_sha256)', () => {
    const dto = serialiseInvoice(invoiceFixture) as Record<string, unknown>;
    expect('pdf_blob_key' in dto).toBe(false);
    expect('receipt_pdf_blob_key' in dto).toBe(false);
    // The PDF surface is still serialised — only the internal storage key is withheld.
    expect(dto['pdf_sha256']).toBe('sha-inv');
    expect(dto['receipt_pdf_sha256']).toBe('sha-rcpt');
  });

  it('serialiseCreditNote omits pdf_blob_key (keeps pdf_sha256)', () => {
    const dto = serialiseCreditNote(creditNoteFixture) as Record<string, unknown>;
    expect('pdf_blob_key' in dto).toBe(false);
    expect(dto['pdf_sha256']).toBe('sha-cn');
  });
});

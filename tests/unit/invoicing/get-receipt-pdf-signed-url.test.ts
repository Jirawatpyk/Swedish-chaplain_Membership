/**
 * Unit tests for `getReceiptPdfSignedUrl`.
 *
 * Pins behaviour across the receipt-state matrix declared in the use-
 * case doc-comment:
 *
 *   combined-mode + paid + rendered    → invoice.pdf.blobKey
 *   separate-mode + paid + rendered    → invoice.receiptPdf.blobKey
 *   separate-mode + paid + pending     → 'receipt_pdf_pending' (member 425)
 *   separate-mode + paid + failed      → 'receipt_pdf_failed'
 *   non-paid                           → 'forbidden'
 *   not-found                          → 'invoice_not_found' + probe
 *   member ownership fail              → 'forbidden' + probe
 *
 * Plus: emits `receipt_pdf_downloaded` only on the happy path.
 */
import { describe, expect, it, vi } from 'vitest';
import { getReceiptPdfSignedUrl } from '@/modules/invoicing/application/use-cases/get-receipt-pdf-signed-url';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const INVOICE_BLOB_KEY = 'invoicing/t/2026/i_v1.pdf';
const RECEIPT_BLOB_KEY = 'invoicing/t/2026/i_receipt_v1.pdf';

function makeBaseInvoice(): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('i'),
    memberId: 'm-owner',
    planId: 'p',
    planYear: 2026,
    status: 'paid',
    draftByUserId: 'u',
    fiscalYear: 2026 as unknown as Invoice['fiscalYear'],
    sequenceNumber: 1,
    documentNumber: {
      raw: 'INV-2026-000001',
      prefix: 'INV',
      fiscalYear: 2026,
      sequenceNumber: 1,
    } as unknown as Invoice['documentNumber'],
    issueDate: '2026-05-15',
    dueDate: '2026-06-14',
    paidAt: '2026-05-16T10:00:00Z',
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(1_000_000n),
    vatRate: null,
    vat: Money.fromSatangUnsafe(70_000n),
    total: Money.fromSatangUnsafe(1_070_000n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: null,
    paymentMethod: 'bank_transfer',
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: 'u',
    paymentDate: '2026-05-16',
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: INVOICE_BLOB_KEY,
      sha256: 'a'.repeat(64),
      templateVersion: 1,
    } as unknown as Invoice['pdf'],
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [],
    createdAt: '2026-05-15T00:00:00Z',
    updatedAt: '2026-05-16T10:00:00Z',
  } as unknown as Invoice;
}

function combinedModeInvoice(): Invoice {
  // Combined-mode: receipt PDF IS a distinct physical file (rendered
  // with kind='receipt_combined' header "ใบกำกับภาษี/ใบเสร็จรับเงิน"),
  // but it reuses the invoice document number — `receiptDocumentNumberRaw`
  // stays null to mark the row as combined.
  return {
    ...makeBaseInvoice(),
    receiptPdfStatus: 'rendered',
    receiptPdf: {
      blobKey: RECEIPT_BLOB_KEY,
      sha256: 'c'.repeat(64),
      templateVersion: 1,
    } as unknown as Invoice['receiptPdf'],
    receiptDocumentNumberRaw: null,
  } as Invoice;
}

function separateRenderedInvoice(): Invoice {
  return {
    ...makeBaseInvoice(),
    receiptPdfStatus: 'rendered',
    receiptPdf: {
      blobKey: RECEIPT_BLOB_KEY,
      sha256: 'b'.repeat(64),
      templateVersion: 1,
    } as unknown as Invoice['receiptPdf'],
    receiptDocumentNumberRaw: 'RC-2026-000001',
  } as Invoice;
}

function separatePendingInvoice(): Invoice {
  return {
    ...makeBaseInvoice(),
    receiptPdfStatus: 'pending',
    receiptPdf: null,
    receiptDocumentNumberRaw: 'RC-2026-000001',
  } as Invoice;
}

function separateFailedInvoice(): Invoice {
  return {
    ...makeBaseInvoice(),
    receiptPdfStatus: 'failed',
    receiptPdf: null,
    receiptDocumentNumberRaw: 'RC-2026-000001',
    receiptPdfLastError: 'render timeout after 30s',
  } as Invoice;
}

function makeDeps(invoice: Invoice | null) {
  const callsKeys: string[] = [];
  const audit = vi.fn(async (_tx: unknown, _ev: unknown) => {});
  const deps = {
    invoiceRepo: {
      findById: vi.fn(async () => invoice),
      // Stubs for unused methods on the port — keep typing happy.
      withTx: vi.fn(),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(),
      list: vi.fn(),
      listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      applyPayment: vi.fn(),
      applyDraftUpdate: vi.fn(),
      lockForUpdate: vi.fn(),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    blob: {
      signDownloadUrl: async (key: string) => {
        callsKeys.push(key);
        return `https://blob.example/${key}?token=stub`;
      },
    } as unknown as Parameters<typeof getReceiptPdfSignedUrl>[0]['blob'],
    audit: { emit: audit },
  };
  return { deps, callsKeys, audit };
}

describe('getReceiptPdfSignedUrl — happy paths', () => {
  it('combined-mode → returns receiptPdf.blobKey + {invoiceDocNum}-receipt.pdf filename + audit', async () => {
    const invoice = combinedModeInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Filename suffix `-receipt.pdf` distinguishes the saved file
      // from the sibling invoice PDF download (`INV-2026-000001.pdf`).
      expect(result.value.filename).toBe('INV-2026-000001-receipt.pdf');
    }
    // Combined-mode receipt PDF is still a distinct physical file
    // from the invoice PDF (rendered with kind='receipt_combined'
    // header bytes). Use-case serves the receipt blob key, not the
    // invoice blob key.
    expect(callsKeys).toEqual([RECEIPT_BLOB_KEY]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('receipt_pdf_downloaded');
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.receipt_numbering_mode).toBe('combined');
    expect(payload.receipt_document_number_raw).toBeNull();
    // R5-CONST-M1 — template_version snapshot makes RD forensic
    // reviewers able to distinguish v=1 (no logo) vs v=2 historical
    // downloads when reconciling re-rendered PDFs. Fixture defaults
    // to templateVersion=1 (see makeBaseInvoice).
    expect(payload.receipt_pdf_template_version).toBe(1);
  });

  it('separate-mode rendered → returns receiptPdf.blobKey + RC filename + audit', async () => {
    const invoice = separateRenderedInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filename).toBe('RC-2026-000001.pdf');
    }
    expect(callsKeys).toEqual([RECEIPT_BLOB_KEY]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.receipt_numbering_mode).toBe('separate');
    expect(payload.receipt_document_number_raw).toBe('RC-2026-000001');
    // R5-CONST-M1 — separate-mode receipt also carries the template
    // version snapshot.
    expect(payload.receipt_pdf_template_version).toBe(1);
  });

  it('member with matching memberId can download the receipt', async () => {
    const invoice = separateRenderedInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-member',
      actorRole: 'member',
      // 054-event-fee-invoices — fixture is a membership invoice with a
      // known non-null memberId; assert for the optional `string` input.
      actorMemberId: invoice.memberId as string,
      invoiceId: 'i',
    });

    expect(result.ok).toBe(true);
    expect(callsKeys).toEqual([RECEIPT_BLOB_KEY]);
    // R9-T4 — symmetric audit-payload assertions with the invoice
    // sibling (`get-invoice-pdf-signed-url.test.ts:304-322`). Pin
    // actor_member_id populated for member-actors + actor_role +
    // route field so future refactors can't silently drop the
    // forensic discriminator that distinguishes admin-actor probes
    // from same-tenant member self-downloads.
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.actor_member_id).toBe('m-owner');
    expect(payload.actor_role).toBe('member');
    expect(payload.route).toBe('get-receipt-pdf-signed-url');
  });

  // R9-T4 — admin actor_member_id MUST be null (vs populated for member).
  // Currently the combined-mode + separate-mode happy paths assert
  // receipt_numbering_mode + template_version but do NOT pin the actor
  // discriminator. Without this pin, a refactor could accidentally
  // leak admin/manager user_id into actor_member_id and break the
  // probe-detection query that filters by `actor_member_id IS NOT NULL`.
  it('admin success → actor_member_id is null + actor_role + route in payload', async () => {
    const invoice = separateRenderedInvoice();
    const { deps, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });

    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.actor_member_id).toBeNull();
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-receipt-pdf-signed-url');
  });

  // R9-T3 mirror — pin the audit-BEFORE-blob ordering contract for
  // the receipt sibling. If audit.emit throws (the exact class of bug
  // that surfaced as the 2026-05-15 migration 0147 gap), the use-case
  // MUST reject WITHOUT issuing a signed URL.
  it('audit emit throws → blob.signDownloadUrl NOT called (forensic safety)', async () => {
    const invoice = separateRenderedInvoice();
    const { deps, callsKeys } = makeDeps(invoice);
    const throwingAudit = vi.fn(async () => {
      throw new Error('Neon transient: 22P02 invalid enum');
    });
    const depsWithThrow = {
      ...deps,
      audit: { emit: throwingAudit } as Parameters<typeof getReceiptPdfSignedUrl>[0]['audit'],
    };
    await expect(
      getReceiptPdfSignedUrl(depsWithThrow, {
        tenantId: 't',
        actorUserId: 'u-admin',
        actorRole: 'admin',
        invoiceId: 'i',
      }),
    ).rejects.toThrow(/Neon transient/);
    expect(throwingAudit).toHaveBeenCalledTimes(1);
    expect(callsKeys).toHaveLength(0);
  });
});

describe('getReceiptPdfSignedUrl — denials', () => {
  it('not paid (issued status) → forbidden, no blob URL, no download audit', async () => {
    const issued = { ...makeBaseInvoice(), status: 'issued' } as Invoice;
    const { deps, callsKeys, audit } = makeDeps(issued);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(callsKeys).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('void status → forbidden', async () => {
    const voided = { ...makeBaseInvoice(), status: 'void' } as Invoice;
    const { deps } = makeDeps(voided);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
  });

  it('cross-tenant (repo returns null) → invoice_not_found + probe audit', async () => {
    const { deps, audit } = makeDeps(null);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-attacker',
      actorRole: 'admin',
      invoiceId: 'foreign',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invoice_not_found');
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('invoice_cross_tenant_probe');
  });

  it('member with mismatched memberId → forbidden + probe audit, no blob URL', async () => {
    const invoice = separateRenderedInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-attacker',
      actorRole: 'member',
      actorMemberId: 'm-other',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(callsKeys).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('invoice_cross_tenant_probe');
  });
});

describe('getReceiptPdfSignedUrl — async + failed states', () => {
  it('separate-mode pending + member → receipt_pdf_pending with 30s retry, no blob URL, no audit', async () => {
    const invoice = separatePendingInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-member',
      actorRole: 'member',
      // 054-event-fee-invoices — fixture is a membership invoice with a
      // known non-null memberId; assert for the optional `string` input.
      actorMemberId: invoice.memberId as string,
      invoiceId: 'i',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('receipt_pdf_pending');
      if (result.error.code === 'receipt_pdf_pending') {
        expect(result.error.retryAfterSeconds).toBe(30);
      }
    }
    expect(callsKeys).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('separate-mode pending + admin → falls through but receiptPdf=null → blob_missing', async () => {
    // Admin doesn't get the 425 gate, but with receiptPdf=null the
    // use-case surfaces blob_missing (the corrupt-state path). Admin
    // route layer is expected to catch this and either render fallback
    // to invoice.pdf OR return a 502.
    const invoice = separatePendingInvoice();
    const { deps } = makeDeps(invoice);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('blob_missing');
  });

  it('separate-mode failed → receipt_pdf_failed with reason surfaced', async () => {
    const invoice = separateFailedInvoice();
    const { deps, callsKeys, audit } = makeDeps(invoice);

    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('receipt_pdf_failed');
      if (result.error.code === 'receipt_pdf_failed') {
        expect(result.error.reason).toBe('render timeout after 30s');
      }
    }
    expect(callsKeys).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

// R10-T1 — blob_missing branch coverage (parity with invoice sibling).
// R9 added a try/catch around signDownloadUrl mapping BlobNotFoundError
// to typed Result. Required by Constitution Principle II "100% branch
// on security-critical use-cases".
describe('getReceiptPdfSignedUrl — blob_missing handling (R10-T1)', () => {
  function makeBlobThrowingDeps(invoice: Invoice, err: unknown) {
    const { deps } = makeDeps(invoice);
    const throwingBlob = {
      signDownloadUrl: async () => {
        throw err;
      },
    } as unknown as Parameters<typeof getReceiptPdfSignedUrl>[0]['blob'];
    return { ...deps, blob: throwingBlob };
  }

  it('BlobNotFoundError → returns blob_missing with key', async () => {
    const invoice = separateRenderedInvoice();
    const err = new Error('BlobNotFoundError: blob not found');
    const deps = makeBlobThrowingDeps(invoice, err);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('blob_missing');
      if (result.error.code === 'blob_missing') {
        expect(result.error.key).toBe(RECEIPT_BLOB_KEY);
      }
    }
  });

  it('Error message containing "404" → returns blob_missing', async () => {
    const invoice = separateRenderedInvoice();
    const err = new Error('Upstream 404 Not Found');
    const deps = makeBlobThrowingDeps(invoice, err);
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('blob_missing');
  });

  it('Generic Error (network) → rethrows (transient, not a miss)', async () => {
    const invoice = separateRenderedInvoice();
    const err = new Error('Connection refused');
    const deps = makeBlobThrowingDeps(invoice, err);
    await expect(
      getReceiptPdfSignedUrl(deps, {
        tenantId: 't',
        actorUserId: 'u-admin',
        actorRole: 'admin',
        invoiceId: 'i',
      }),
    ).rejects.toThrow(/Connection refused/);
  });

  it('Non-Error throw (string) → still resolves via String(e) regex', async () => {
    const invoice = separateRenderedInvoice();
    const deps = makeBlobThrowingDeps(invoice, 'string-style not found error');
    const result = await getReceiptPdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('blob_missing');
  });
});

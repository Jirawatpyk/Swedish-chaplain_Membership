/**
 * C1 (verify-run remediation, 2026-04-20) — `getInvoicePdfSignedUrl`
 * unit coverage focused on the **byte-identical guarantee for
 * admin↔portal downloads** (FR-016 / CP-5.2).
 *
 * The full byte-equality assertion (sha256 of the streamed PDF blob)
 * requires a fixture-seeded E2E that actually issues an invoice +
 * uploads to Vercel Blob — tracked as E2E debt. This unit test
 * asserts the **transitive** guarantee one level above that:
 *
 *   For the same `Invoice` row, `getInvoicePdfSignedUrl` resolves to
 *   the **same `blobKey`** regardless of `actorRole`. Combined with
 *   the deterministic-PDF policy (FR-016: `react-pdf` adapter pinned
 *   to the invoice's stored `templateVersion`), identical blob key →
 *   identical bytes when streamed through Vercel Blob.
 *
 * Also pins:
 *   - Members with matching memberId pass the ownership guard.
 *   - Drafts (no pdf) return `forbidden` regardless of role.
 *   - Members with mismatched memberId return `forbidden` + emit
 *     `invoice_cross_tenant_probe` (already covered in T069
 *     integration, mirrored here at unit speed).
 */
import { describe, expect, it, vi } from 'vitest';
import { getInvoicePdfSignedUrl } from '@/modules/invoicing/application/use-cases/get-invoice-pdf-signed-url';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const STORED_BLOB_KEY = 'tenants/t/invoices/i/v1.pdf';

function makeIssuedInvoice(): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('i'),
    memberId: 'm-owner',
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    draftByUserId: 'u',
    fiscalYear: 2026 as unknown as Invoice['fiscalYear'],
    sequenceNumber: 1,
    documentNumber: {
      raw: 'I-2026-000001',
      prefix: 'I',
      fiscalYear: 2026,
      sequenceNumber: 1,
    } as unknown as Invoice['documentNumber'],
    issueDate: '2026-04-20',
    dueDate: '2026-05-20',
    paidAt: null,
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
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: STORED_BLOB_KEY,
      sha256: 'a'.repeat(64),
      templateVersion: 1,
      generatedAt: '2026-04-20T00:00:00Z',
      generatedByUserId: 'u',
    } as unknown as Invoice['pdf'],
    receiptPdf: null,
    lines: [],
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
  } as unknown as Invoice;
}

interface BlobSpy {
  signDownloadUrl: (key: string, ttl?: number) => Promise<string>;
  callsKeys: string[];
}

function makeDeps(invoice: Invoice | null) {
  const callsKeys: string[] = [];
  const blob: BlobSpy = {
    signDownloadUrl: async (key: string) => {
      callsKeys.push(key);
      return `https://blob.example/${key}?token=stub`;
    },
    callsKeys,
  };
  const audit: (a: unknown, b: unknown) => Promise<void> = vi.fn(async () => {});
  return {
    deps: {
      invoiceRepo: {
        withTx: vi.fn(),
        insertDraft: vi.fn(),
        findByIdInTx: vi.fn(),
        findById: vi.fn(async () => invoice),
        list: vi.fn(),
        listPaged: vi.fn(),
        applyIssue: vi.fn(),
        deleteDraft: vi.fn(),
        applyPayment: vi.fn(),
        applyDraftUpdate: vi.fn(),
        lockForUpdate: vi.fn(async () => 'issued' as const),
        applyCreditNoteRollup: vi.fn(),
        applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      },
      blob: { signDownloadUrl: blob.signDownloadUrl } as unknown as Parameters<
        typeof getInvoicePdfSignedUrl
      >[0]['blob'],
      audit: { emit: audit },
    },
    blob,
    audit,
  };
}

describe('getInvoicePdfSignedUrl — byte-identical admin↔portal (C1)', () => {
  it('admin and member-with-matching-memberId resolve to the same blobKey', async () => {
    const invoice = makeIssuedInvoice();
    const adminCall = makeDeps(invoice);
    const memberCall = makeDeps(invoice);

    const adminResult = await getInvoicePdfSignedUrl(adminCall.deps, {
      tenantId: 't',
      actorUserId: 'u-admin',
      actorRole: 'admin',
      invoiceId: 'i',
    });
    const memberResult = await getInvoicePdfSignedUrl(memberCall.deps, {
      tenantId: 't',
      actorUserId: 'u-member',
      actorRole: 'member',
      actorMemberId: invoice.memberId,
      invoiceId: 'i',
    });

    expect(adminResult.ok).toBe(true);
    expect(memberResult.ok).toBe(true);

    // The transitive byte-identical guarantee for FR-016 / CP-5.2:
    // both routes signed the SAME blob key, so Vercel Blob will
    // stream the SAME object → identical sha256.
    expect(adminCall.blob.callsKeys).toEqual([STORED_BLOB_KEY]);
    expect(memberCall.blob.callsKeys).toEqual([STORED_BLOB_KEY]);
    expect(memberCall.blob.callsKeys).toEqual(adminCall.blob.callsKeys);

    // Filename is deterministic from the stored documentNumber so
    // the Content-Disposition is also identical across roles.
    if (adminResult.ok && memberResult.ok) {
      expect(memberResult.value.filename).toBe(adminResult.value.filename);
    }
  });

  it('member with mismatched memberId is blocked + emits probe — same-tenant guard', async () => {
    const invoice = makeIssuedInvoice();
    const { deps, audit, blob } = makeDeps(invoice);
    const result = await getInvoicePdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-attacker',
      actorRole: 'member',
      actorMemberId: 'm-other',
      invoiceId: 'i',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(blob.callsKeys, 'must NOT sign a URL when ownership fails').toEqual(
      [],
    );
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('drafts (no pdf) return forbidden regardless of role', async () => {
    const draft = { ...makeIssuedInvoice(), status: 'draft', pdf: null } as Invoice;
    const { deps } = makeDeps(draft);
    const result = await getInvoicePdfSignedUrl(deps, {
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
    const result = await getInvoicePdfSignedUrl(deps, {
      tenantId: 't',
      actorUserId: 'u-attacker',
      actorRole: 'member',
      actorMemberId: 'm',
      invoiceId: 'foreign',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invoice_not_found');
    expect(audit).toHaveBeenCalledTimes(1);
  });
});


/**
 * 088 (FR-001 / FR-014) — previewInvoiceDraft threads the tax-at-payment flag
 * into the render as `billMode`, so the admin's DRAFT preview matches what
 * `issueInvoice` will render: the non-tax ใบแจ้งหนี้ when the flag is ON, the
 * legacy §86/4 Tax-Invoice title when OFF.
 *
 * Guards the preview-vs-issued parity: without this threading the preview would
 * mistitle the bill as ใบกำกับภาษี / Tax Invoice even though the issued document
 * is a ใบแจ้งหนี้ (the issue path is e2e-covered by invoice-draft-issue.spec.ts;
 * this pins the preview use-case branch itself, which was otherwise untested).
 */
import { describe, it, expect } from 'vitest';
import {
  previewInvoiceDraft,
  type PreviewInvoiceDraftDeps,
} from '@/modules/invoicing/application/use-cases/preview-invoice-draft';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { TaxAtPaymentFlag } from '@/modules/invoicing/domain/tax-at-payment-flag';

const INVOICE_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps(
  taxAtPayment: TaxAtPaymentFlag,
  capture: { input?: PdfRenderInput },
): PreviewInvoiceDraftDeps {
  const draft = {
    status: 'draft' as const,
    memberId: 'mem-1',
    invoiceSubject: 'membership' as const,
    lines: [{ total: Money.fromSatangUnsafe(100_000n) }],
  };
  const settings = {
    vatRate: VatRate.ofUnsafe('0.0700'),
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null, // → loadTenantLogo short-circuits, no blob call
    },
  };
  const member = {
    snapshot: {
      legal_name: 'Acme Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    },
  };
  return {
    invoiceRepo: {
      withTx: (fn: (tx: unknown) => unknown) => fn({}),
      findByIdInTx: async () => draft,
    },
    tenantSettingsRepo: { getForIssue: async () => settings },
    memberIdentity: { getForIssue: async () => member },
    pdfRender: {
      render: async (input: PdfRenderInput) => {
        capture.input = input;
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), sha256: 'a'.repeat(64) };
      },
    },
    blob: {},
    clock: { nowIso: () => '2026-07-04T00:00:00Z' },
    currentTemplateVersion: 8,
    taxAtPayment,
  } as unknown as PreviewInvoiceDraftDeps;
}

describe('previewInvoiceDraft — 088 billMode threading (FR-001 / FR-014)', () => {
  it('threads billMode:true when taxAtPayment is ON (preview = non-tax ใบแจ้งหนี้)', async () => {
    const cap: { input?: PdfRenderInput } = {};
    const r = await previewInvoiceDraft(makeDeps('on', cap), {
      tenantId: 't',
      invoiceId: INVOICE_ID,
    });
    expect(r.ok).toBe(true);
    expect(cap.input?.kind).toBe('invoice_preview');
    // The load-bearing assertion — fails if the flag threading is dropped.
    expect(cap.input?.billMode).toBe(true);
  });

  it("billMode:false when the flag is 'off' (legacy §86/4 Tax-Invoice preview)", async () => {
    const capOff: { input?: PdfRenderInput } = {};
    await previewInvoiceDraft(makeDeps('off', capOff), {
      tenantId: 't',
      invoiceId: INVOICE_ID,
    });
    expect(capOff.input?.billMode).toBe(false);

    const capUndef: { input?: PdfRenderInput } = {};
    await previewInvoiceDraft(makeDeps('off', capUndef), {
      tenantId: 't',
      invoiceId: INVOICE_ID,
    });
    expect(capUndef.input?.billMode).toBe(false);
  });
});

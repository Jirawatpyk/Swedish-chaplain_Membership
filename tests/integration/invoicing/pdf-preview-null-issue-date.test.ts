/**
 * Regression guard — `invoice_preview` renders successfully when the
 * Application layer passes `issueDate: null`.
 *
 * The port contract (`pdf-render-port.ts`) explicitly marks `issueDate`
 * as `string | null` with the comment "null for preview". An earlier
 * revision of `deterministic-render.ts:pinnedDateFromInput` threw
 * unconditionally when `issueDate` was not a string, which crashed
 * every call to `preview-invoice-draft` use-case at the UI Preview
 * button with HTTP 500. See stack trace landed on `/admin/invoices/
 * :id/preview` before this fix was in place.
 *
 * What we assert:
 *   1. `render` returns a valid PDF (magic header + %%EOF trailer) when
 *      the caller passes `issueDate: null` for `kind === 'invoice_preview'`.
 *   2. Two preview renders with identical input produce byte-length-
 *      identical output — the epoch-date fallback in
 *      `pinnedDateFromInput` must be stable, not `new Date()`.
 *   3. Real (non-preview) kinds with `issueDate: null` STILL throw —
 *      the fail-fast compliance guard for signed documents is intact.
 *
 * No DB required — exercises the adapter + deterministic-render helper
 * directly, same pattern as `pdf-deterministic.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import {
  asInvoiceLineId,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';

function makeLines(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000b1'),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026 (ตัวอย่าง)',
      descriptionEn: 'Membership 2026 (preview)',
      unitPrice: Money.fromSatangUnsafe(100_000n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(100_000n),
      position: 1,
    },
  ];
}

function makePreviewInput(): PdfRenderInput {
  return {
    kind: 'invoice_preview',
    templateVersion: 1,
    documentNumber: null,
    issueDate: null,
    dueDate: null,
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'Acme Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      // 055-member-number — additive fields on the snapshot (null → no line).
      member_number: null,
      member_number_display: null,
    },
    // 059 / PR-A Task 6b — templateVersion 1 predates the v11 registrant gate
    // (this file's subject is the null-issueDate crash guard); `true` matches
    // the fixture's own `tax_id` presence.
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

describe('F4 PDF preview — null issueDate regression guard', () => {
  it('renders a valid PDF for kind=invoice_preview with issueDate=null', async () => {
    const input = makePreviewInput();
    const out = await reactPdfRenderAdapter.render(input);

    expect(out.bytes.byteLength).toBeGreaterThan(1_000);
    expect(Buffer.from(out.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(out.bytes.slice(-6)).toString('latin1').includes('%%EOF'))
      .toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('two preview renders with identical input produce same byte length (stable epoch pin)', async () => {
    const input = makePreviewInput();
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    expect(b.bytes.byteLength).toBe(a.bytes.byteLength);
  }, 120_000);

  it('non-preview kinds with issueDate=null STILL throw (compliance fail-fast intact)', async () => {
    const badInput: PdfRenderInput = {
      ...makePreviewInput(),
      kind: 'invoice',
    };
    await expect(reactPdfRenderAdapter.render(badInput)).rejects.toThrow(
      /issueDate is required for deterministic CreationDate pinning/,
    );
  }, 60_000);
});

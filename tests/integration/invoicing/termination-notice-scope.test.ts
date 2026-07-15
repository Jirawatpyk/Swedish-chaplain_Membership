/**
 * 065 renewal-swecham-alignment (§5.4) — the statutory termination notice
 * renders on the ใบแจ้งหนี้ (bill) ONLY, NEVER on any §86/4 / §105 / §86/10 tax
 * document. Bill-only + v12 version gate.
 *
 * Mirrors wht-note-scope's deterministic ELEMENT-TREE harness (`makeInput` /
 * `pagesOf` / `pageText`): `@react-pdf/renderer` maps one PDF page per `<Page>`.
 * No live Neon — the notice rides the pinned `TenantIdentitySnapshot`, so this
 * drives `InvoiceTemplate(input)` directly with the snapshot field populated.
 *
 * The RENDER gate is `isBill && templateVersion >= 12` (isBill = kind
 * invoice/invoice_preview + billMode). It is DELIBERATELY not the WHT note's
 * `invoice_subject==='membership'` gate — that gate ALSO fires on the paid §86/4
 * receipt, and the notice must never leak onto a tax document.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { shapeThai } from '@/modules/invoicing/infrastructure/pdf/fonts/register-sarabun';
import type {
  PdfDocKind,
  PdfRenderInput,
} from '@/modules/invoicing/application/ports/pdf-render-port';
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const NOTICE_TH =
  'PLACEHOLDER: SweCham มีหน้าที่ตามระเบียบต้องยุติสมาชิกภาพของผู้ค้างชำระภายใน 60 วัน';
const NOTICE_EN = 'PLACEHOLDER: SweCham is regulatory-bound to terminate members with unpaid fees.';

function makeLines(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000a1'),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPrice: Money.fromSatangUnsafe(100_000n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(100_000n),
      position: 1,
    },
  ];
}

/** A tenant snapshot with the §5.4 termination notice populated. */
function tenantWithNotice(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    termination_notice_th: NOTICE_TH,
    termination_notice_en: NOTICE_EN,
  };
}

function makeInput(opts: {
  templateVersion: number;
  kind?: PdfDocKind;
  invoiceSubject?: 'membership' | 'event';
  billMode?: boolean;
  tenant?: TenantIdentitySnapshot;
}): PdfRenderInput {
  const docR = DocumentNumber.of('SC', 2026, 123);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: opts.kind ?? 'invoice',
    templateVersion: opts.templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    invoiceSubject: opts.invoiceSubject ?? 'membership',
    // exactOptionalPropertyTypes — only set billMode when defined.
    ...(opts.billMode !== undefined ? { billMode: opts.billMode } : {}),
    tenant: opts.tenant ?? tenantWithNotice(),
    member: {
      legal_name: 'Acme Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    },
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return [];
}

function pagesOf(el: ReactElement): ReactElement[] {
  expect(el.type).toBe(Document);
  return Children.toArray((el.props as { children?: ReactNode }).children).filter(
    (c): c is ReactElement => isValidElement(c) && c.type === Page,
  );
}

function pageText(page: ReactElement): string {
  return collectText(page).join('');
}

/** Every page of a document flattened to one text blob. */
function allText(input: PdfRenderInput): string {
  return pagesOf(InvoiceTemplate(input))
    .map(pageText)
    .join('');
}

describe('065 §5.4 — statutory termination notice scope (bill-only, v12-gated)', () => {
  it('renders the notice (TH + EN) on the ใบแจ้งหนี้ (bill) — kind=invoice, billMode=true, v12', () => {
    const text = allText(
      makeInput({ templateVersion: 12, kind: 'invoice', billMode: true }),
    );
    expect(text).toContain(shapeThai(NOTICE_TH));
    expect(text).toContain(NOTICE_EN);
  });

  it('does NOT render on the §86/4 tax receipt (receipt_combined, v12)', () => {
    const text = allText(
      makeInput({ templateVersion: 12, kind: 'receipt_combined', invoiceSubject: 'membership' }),
    );
    expect(text).not.toContain(shapeThai(NOTICE_TH));
    expect(text).not.toContain(NOTICE_EN);
  });

  it('does NOT render on the §105 receipt_separate or §86/10 credit_note (v12)', () => {
    for (const kind of ['receipt_separate', 'credit_note'] as const) {
      const text = allText(makeInput({ templateVersion: 12, kind }));
      expect(text).not.toContain(shapeThai(NOTICE_TH));
      expect(text).not.toContain(NOTICE_EN);
    }
  });

  it('does NOT render on a pre-v12 (@v11) bill (SC-003 byte-determinism)', () => {
    const text = allText(
      makeInput({ templateVersion: 11, kind: 'invoice', billMode: true }),
    );
    expect(text).not.toContain(shapeThai(NOTICE_TH));
    expect(text).not.toContain(NOTICE_EN);
  });
});

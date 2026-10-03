// @vitest-environment node
/**
 * §86/10 วรรคสอง — a ใบลดหนี้ must show, besides the original tax invoice's
 * number and date and the reason, the value of goods/services per the
 * original tax invoice, the correct value, the difference, and the VAT on the
 * difference.
 *
 * Template v13 prints those four lines in the credit note's reference block.
 * Gated on `templateVersion >= 13` AND the values being supplied, so a pinned
 * pre-v13 render reproduces its original output (SC-003).
 *
 * Element-tree assertion (as wht-note-scope / branch-render): no PDF bytes,
 * no DB.
 */
import { describe, expect, it } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { shapeThai } from '@/modules/invoicing/infrastructure/pdf/fonts/register-sarabun';
import { formatThbSatang } from '@/modules/invoicing/infrastructure/pdf/format-thb';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';

const VALUES = {
  originalValue: Money.fromSatangUnsafe(2_336_400n),
  previouslyReduced: Money.fromSatangUnsafe(0n),
  correctValue: Money.fromSatangUnsafe(1_168_200n),
  difference: Money.fromSatangUnsafe(1_168_200n),
  differenceVat: Money.fromSatangUnsafe(81_800n),
};

function makeInput(
  templateVersion: number,
  withValues: boolean,
  values: typeof VALUES = VALUES,
): PdfRenderInput {
  const docR = DocumentNumber.of('CN', 2026, 1);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: 'credit_note',
    templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-10-03',
    dueDate: null,
    invoiceSubject: 'membership',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0994000187203',
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
      member_number: null,
      member_number_display: null,
    },
    lines: [
      {
        lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000c1'),
        kind: 'registration_fee',
        descriptionTh: 'ลดหนี้ตาม RC-2026-000088',
        descriptionEn: 'Credit against RC-2026-000088',
        unitPrice: VALUES.difference,
        quantity: '1.0000',
        proRateFactor: null,
        total: VALUES.difference,
        position: 1,
      },
    ],
    subtotal: VALUES.difference,
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: VALUES.differenceVat,
    total: Money.fromSatangUnsafe(1_250_000n),
    creditNote: {
      originalDocumentNumber: 'RC-2026-000088',
      originalIssueDate: '2026-09-20',
      reason: 'Partial refund',
      ...(withValues ? { values } : {}),
    },
  } as PdfRenderInput;
}

function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (isValidElement(node)) return collectText((node.props as { children?: ReactNode }).children);
  return [];
}

function firstPageText(el: ReactElement): string {
  expect(el.type).toBe(Document);
  const pages = Children.toArray((el.props as { children?: ReactNode }).children).filter(
    (c): c is ReactElement => isValidElement(c) && c.type === Page,
  );
  return collectText(pages[0]).join('');
}

const fmt = (m: Money) => formatThbSatang(m.satang, true);

describe('credit note — §86/10 value lines (template v13)', () => {
  it('the current template version is at least 13', () => {
    expect(CURRENT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(13);
  });

  it('prints the original value, the correct value, the difference and the VAT on the difference', () => {
    const text = firstPageText(InvoiceTemplate(makeInput(13, true)));
    expect(text).toContain(`${shapeThai('มูลค่าตามใบกำกับภาษีเดิม')} / Value per original tax invoice: ${fmt(VALUES.originalValue)}`);
    expect(text).toContain(`${shapeThai('มูลค่าที่ถูกต้อง')} / Correct value: ${fmt(VALUES.correctValue)}`);
    expect(text).toContain(`${shapeThai('ผลต่าง')} / Difference: ${fmt(VALUES.difference)}`);
    expect(text).toContain(`${shapeThai('ภาษีมูลค่าเพิ่มของผลต่าง')} / VAT on the difference: ${fmt(VALUES.differenceVat)}`);
    // The existing reference lines stay.
    expect(text).toContain('RC-2026-000088');
    expect(text).toContain('Partial refund');
  });

  it('a first note prints no "previously reduced" line', () => {
    const text = firstPageText(InvoiceTemplate(makeInput(13, true)));
    expect(text).not.toContain('Previously reduced');
  });

  it('a later note states what earlier notes reduced, so original − previously reduced − correct = difference', () => {
    const later = {
      originalValue: Money.fromSatangUnsafe(100_000n),
      previouslyReduced: Money.fromSatangUnsafe(25_000n),
      correctValue: Money.fromSatangUnsafe(50_000n),
      difference: Money.fromSatangUnsafe(25_000n),
      differenceVat: Money.fromSatangUnsafe(1_750n),
    };
    const text = firstPageText(InvoiceTemplate(makeInput(13, true, later)));
    expect(text).toContain(`${shapeThai('ลดหนี้ครั้งก่อน')} / Previously reduced: ${fmt(later.previouslyReduced)}`);
    expect(text).toContain(`Correct value: ${fmt(later.correctValue)}`);
  });

  it('a pinned pre-v13 render prints none of them (SC-003)', () => {
    const text = firstPageText(InvoiceTemplate(makeInput(12, true)));
    expect(text).not.toContain('Value per original tax invoice');
    expect(text).not.toContain('Correct value');
    expect(text).not.toContain('VAT on the difference');
  });

  it('a v13 render without the values prints none of them', () => {
    const text = firstPageText(InvoiceTemplate(makeInput(13, false)));
    expect(text).not.toContain('Value per original tax invoice');
  });
});

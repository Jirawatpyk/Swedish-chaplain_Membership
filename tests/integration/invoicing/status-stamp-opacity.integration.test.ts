/**
 * 094-status-watermark-opacity — the diagonal VOID / CREDITED status stamp must
 * render as a LARGE FAINT (~10% opacity) behind-content watermark from v10, not
 * the pre-v10 prominent 32-50% opacity that clashed with the opaque table-header
 * row + line-item text on a credited/voided tax document (prod UAT defect).
 *
 * Home = integration (node env): the assertion imports `@react-pdf/renderer`
 * (Node-oriented) + the shared `InvoiceTemplate`, exactly like
 * `original-copy.integration.test.ts`. The primary assertions traverse the
 * `InvoiceTemplate` element tree (deterministic, no PDF parser) and read the
 * resolved `style.color` on the stamp `<Text>` — the ONLY thing v10 changes.
 *
 * SC-003 (byte-determinism): the faint stamp is gated on
 * `templateVersion >= STATUS_STAMP_FAINT_MIN_VERSION` (=10, bumped
 * CURRENT_TEMPLATE_VERSION 9→10). A pinned pre-v10 voided / credited document
 * (resend / void-overlay / credited-annotation re-render at its stored
 * `pdf_template_version`) reproduces its ORIGINAL prominent stamp. A document
 * with NO status stamp (plain invoice / receipt) renders byte-length-identical
 * at v9 and v10 — proven at the REAL adapter level below.
 */
import { describe, it, expect } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Text } from '@react-pdf/renderer';
import {
  InvoiceTemplate,
  STATUS_STAMP_FAINT_MIN_VERSION,
} from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfDocKind, PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const V_FAINT = STATUS_STAMP_FAINT_MIN_VERSION; // 10 — first faint-stamp version.
const V_LEGACY = STATUS_STAMP_FAINT_MIN_VERSION - 1; // 9 — last prominent-stamp version.

// Pre-v10 (prominent) stamp colours — the ORIGINAL bytes an already-issued
// document MUST reproduce on re-render (SC-003).
const VOID_PROMINENT = 'rgba(200,0,0,0.5)';
const CREDITED_PROMINENT = 'rgba(180,80,0,0.32)';
// v10+ faint behind-content stamp colours — hue preserved, opacity ~10%.
const VOID_FAINT = 'rgba(200,0,0,0.10)';
const CREDITED_FAINT = 'rgba(180,80,0,0.10)';

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

function makeInput(
  kind: PdfDocKind,
  templateVersion: number,
  extra: Partial<PdfRenderInput> = {},
): PdfRenderInput {
  const docR = DocumentNumber.of('SC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind,
    templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
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
      member_number: null,
      member_number_display: null,
    },
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
    // 059 / PR-A Task 6b — irrelevant to this file's subject (stamp opacity);
    // `true` matches the fixture's own `tax_id`. Set BEFORE `...extra` so a
    // caller can still override it.
    ...extra,
  };
}

const CREDITED_ANNOTATION = {
  fullyCredited: true,
  references: [
    {
      documentNumber: 'SC-2026-000099',
      issueDate: '2026-04-20',
      total: Money.fromSatangUnsafe(107_000n),
    },
  ],
} as const;

const PARTIAL_ANNOTATION = { ...CREDITED_ANNOTATION, fullyCredited: false } as const;

/** Recursively collect every string/number leaf under a React node. */
function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** The first `<Text>` element whose flattened text contains `needle`. */
function findText(node: ReactNode, needle: string): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findText(child, needle);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === Text && collectText(node).includes(needle)) {
    return node;
  }
  return findText((node.props as { children?: ReactNode }).children, needle);
}

function colorOf(el: ReactElement | undefined): string | undefined {
  return (el?.props as { style?: { color?: string } } | undefined)?.style?.color;
}

describe('094 — status watermark opacity (large FAINT behind-content stamp, v10-gated)', () => {
  it('v10 VOID stamp renders at faint ~10% opacity; geometry (size/angle) preserved', () => {
    const stamp = findText(
      InvoiceTemplate(makeInput('void_stamped_invoice', V_FAINT, { voidReason: 'x' })),
      'VOID',
    );
    expect(stamp, 'expected a VOID stamp Text element').toBeDefined();
    expect(colorOf(stamp)).toBe(VOID_FAINT);
    // The defect was the OPACITY, not the size/angle — a large faint diagonal is
    // the correct look. Assert the geometry is unchanged.
    const style = (stamp!.props as { style: { fontSize: number; transform: string } }).style;
    expect(style.fontSize).toBe(80);
    expect(style.transform).toBe('rotate(-45deg)');
  });

  it('pre-v10 VOID stamp keeps the ORIGINAL prominent 50% opacity (SC-003 re-render)', () => {
    const stamp = findText(
      InvoiceTemplate(makeInput('void_stamped_invoice', V_LEGACY, { voidReason: 'x' })),
      'VOID',
    );
    expect(colorOf(stamp)).toBe(VOID_PROMINENT);
  });

  it('v10 fully-CREDITED stamp renders at faint ~10% opacity; geometry preserved', () => {
    const stamp = findText(
      InvoiceTemplate(makeInput('invoice', V_FAINT, { creditedAnnotation: CREDITED_ANNOTATION })),
      'CREDITED',
    );
    expect(stamp, 'expected a CREDITED stamp Text element').toBeDefined();
    expect(colorOf(stamp)).toBe(CREDITED_FAINT);
    const style = (stamp!.props as { style: { fontSize: number; transform: string } }).style;
    expect(style.fontSize).toBe(64);
    expect(style.transform).toBe('rotate(-20deg)');
  });

  it('v10 PARTIALLY CREDITED stamp is faint too (same style path)', () => {
    const stamp = findText(
      InvoiceTemplate(makeInput('invoice', V_FAINT, { creditedAnnotation: PARTIAL_ANNOTATION })),
      'PARTIALLY CREDITED',
    );
    expect(colorOf(stamp)).toBe(CREDITED_FAINT);
  });

  it('pre-v10 CREDITED stamp keeps the ORIGINAL prominent 32% opacity (SC-003 re-render)', () => {
    const stamp = findText(
      InvoiceTemplate(makeInput('invoice', V_LEGACY, { creditedAnnotation: CREDITED_ANNOTATION })),
      'CREDITED',
    );
    expect(colorOf(stamp)).toBe(CREDITED_PROMINENT);
  });

  it('DRAFT preview watermark is UNTOUCHED (#eee, already faint) at both v9 and v10', () => {
    for (const v of [V_LEGACY, V_FAINT]) {
      const draft = findText(InvoiceTemplate(makeInput('invoice_preview', v)), 'DRAFT');
      expect(colorOf(draft), `DRAFT watermark @v${v}`).toBe('#eee');
    }
  });

  it('SC-003 byte-safety: a plain invoice (NO status stamp) renders byte-length-identical at v9 and v10', async () => {
    const v9 = await reactPdfRenderAdapter.render(makeInput('invoice', V_LEGACY));
    const v10 = await reactPdfRenderAdapter.render(makeInput('invoice', V_FAINT));
    // The v10 change touches ONLY the void/credited stamp styles, which a plain
    // invoice never renders — so its bytes must be unaffected across the bump.
    expect(v10.bytes.byteLength).toBe(v9.bytes.byteLength);
  }, 90_000);
});

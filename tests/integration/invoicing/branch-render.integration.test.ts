/**
 * 088-invoice-tax-flow-redesign — T028 [US3] §86/4 Head-Office / Branch on both
 * parties (FR-008 / US3 AS1-4).
 *
 * The §86/4 branch line renders on BOTH the ใบแจ้งหนี้ (bill) and the tax receipt
 * (it lives inside `renderPageBody`, so a two-page combined receipt shows it on
 * the Original AND the Copy):
 *   - AS1 VAT-registrant juristic buyer + NO branch  → buyer "สำนักงานใหญ่ / Head
 *     Office" (default, NOT blocked).
 *   - AS2 buyer set to a branch code                 → buyer "สาขาที่ NNNNN / Branch".
 *   - AS3 individual / NULL legal_entity_type buyer  → NO buyer branch line
 *     (fail-closed — gated on `buyer_is_vat_registrant`, NEVER `buyerHasTin`).
 *   - AS4 the SELLER block always shows TSCC as สำนักงานใหญ่ / Head Office.
 *
 * SC-003 (byte-determinism): both new lines gate on `templateVersion >= 5`
 * (bumped CURRENT_TEMPLATE_VERSION 4→5). A pinned pre-v5 document paginates with
 * NO branch line on either party — asserted below — so already-issued documents
 * re-render byte-for-length identical.
 *
 * Deterministic ELEMENT-TREE assertion (mirrors original-copy.integration.test.ts):
 * `@react-pdf/renderer` maps one PDF page per `<Page>` element, and the seller +
 * buyer §86/4 blocks live on every page. The seller ALWAYS renders "Head Office"
 * at v5, so buyer-vs-seller is discriminated by COUNTING the "Head Office" marker
 * (seller = 1; +1 when the buyer is a head-office registrant). No live Neon.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { shapeThai } from '@/modules/invoicing/infrastructure/pdf/fonts/register-sarabun';
import { resolveBuyerIsVatRegistrant } from '@/modules/invoicing/domain/document-kind';
import type { PdfDocKind, PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const HEAD_OFFICE_EN = 'Head Office';
const BRANCH_EN = 'Branch';
const HEAD_OFFICE_TH = shapeThai('สำนักงานใหญ่');
const BRANCH_CODE = '00042';
const BRANCH_TH = shapeThai('สาขาที่ ' + BRANCH_CODE);

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

function makeInput(opts: {
  templateVersion: number;
  kind?: PdfDocKind;
  member?: Partial<MemberIdentitySnapshot>;
  /**
   * 059 / PR-A Task 6b — the RESOLVED top-level field `buyerTaxIdEl` reads.
   * `buyerBranchEl` (this file's subject) deliberately does NOT read this field
   * — it stays keyed on the snapshot's own `buyer_is_vat_registrant`. Defaults
   * to that same snapshot flag so every pre-Task-6b test below is unaffected.
   */
  buyerIsVatRegistrant?: boolean;
}): PdfRenderInput {
  const docR = DocumentNumber.of('RC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const member = {
    legal_name: 'Acme Co., Ltd.',
    tax_id: '1234567890123',
    address: '99/1 Sukhumvit Rd',
    primary_contact_name: 'John Doe',
    primary_contact_email: 'john@acme.example',
    member_number: null,
    member_number_display: null,
    ...opts.member,
  };
  return {
    kind: opts.kind ?? 'invoice',
    templateVersion: opts.templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    // The seller (tenant) snapshot omits `seller_is_head_office` → the template
    // falls back to `?? true` → สำนักงานใหญ่ (AS4). US5 wires the tenant columns.
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0994000187203',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member,
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

/** Recursively collect every string/number leaf under a React node. */
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

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('088 US3 — §86/4 Head-Office / Branch on both parties (FR-008)', () => {
  it('AS1: VAT-registrant juristic buyer, no branch → buyer สำนักงานใหญ่ / Head Office (default), issuance NOT blocked', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          member: {
            buyer_is_vat_registrant: true,
            buyer_is_head_office: true,
            buyer_branch_code: null,
          },
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // Seller (always) + buyer (registrant head office) → TWO "Head Office" lines.
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(2);
    expect(text).toContain(HEAD_OFFICE_TH);
    // No branch line anywhere.
    expect(text).not.toContain(BRANCH_EN);
  });

  it('AS2: buyer set to a branch code → buyer สาขาที่ NNNNN / Branch (seller stays head office)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          member: {
            buyer_is_vat_registrant: true,
            buyer_is_head_office: false,
            buyer_branch_code: BRANCH_CODE,
          },
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // Buyer branch line present.
    expect(text).toContain(BRANCH_EN);
    expect(text).toContain(BRANCH_TH);
    expect(text).toContain(BRANCH_CODE);
    // Seller is the ONLY head-office line (buyer is a branch).
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(1);
  });

  it('AS3: individual / NULL legal_entity_type buyer (buyer_is_vat_registrant=false) → NO buyer branch line (fail-closed)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          member: { buyer_is_vat_registrant: false },
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // Only the seller head-office line — the buyer contributes none.
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(1);
    expect(text).not.toContain(BRANCH_EN);
    expect(text).not.toContain(BRANCH_TH);
  });

  it('AS3 (fail-closed): a snapshot that OMITS buyer_is_vat_registrant (historical / undefined) also renders NO buyer branch line', () => {
    const page = pagesOf(
      InvoiceTemplate(makeInput({ templateVersion: 5 })),
    )[0]!;
    const text = pageText(page);
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(1); // seller only
    expect(text).not.toContain(BRANCH_EN);
  });

  it('AS4: the seller block always shows TSCC as สำนักงานใหญ่ / Head Office (even for a branch buyer)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          member: {
            buyer_is_vat_registrant: true,
            buyer_is_head_office: false,
            buyer_branch_code: BRANCH_CODE,
          },
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // The seller Head-Office line is present regardless of the buyer being a branch.
    expect(text).toContain(HEAD_OFFICE_EN);
    expect(text).toContain(HEAD_OFFICE_TH);
  });

  it('renders on BOTH pages of the two-page combined receipt (Original + Copy) — the line lives in renderPageBody', () => {
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          kind: 'receipt_combined',
          member: {
            buyer_is_vat_registrant: true,
            buyer_is_head_office: false,
            buyer_branch_code: BRANCH_CODE,
          },
        }),
      ),
    );
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      const text = pageText(p);
      expect(text).toContain(BRANCH_TH);
      expect(text).toContain(BRANCH_CODE);
      // The seller head-office line prints on both pages too.
      expect(text).toContain(HEAD_OFFICE_EN);
    }
  });

  it('059 / PR-A Task 6b: a WALK-IN whose TIN made buyerIsVatRegistrant=true still gets NO branch line', () => {
    // CRITICAL constraint from the Task 6b fix: `buyerBranchEl` must NEVER read
    // the top-level `buyerIsVatRegistrant` field (buyerTaxIdEl's source) — only
    // the snapshot's own RECORDED `buyer_is_vat_registrant`. A walk-in's TIN can
    // make the top-level field `true` (it classed the document as an invoice),
    // but a 13-digit number is not proof of head-office/branch status — a Thai
    // natural person's national ID is also 13 digits. This is a known,
    // pre-existing gap (088 US3): a walk-in never gets a branch line either way.
    const walkInSnapshotParts = {
      tax_id: '1234567890123',
      buyer_is_vat_registrant: false as const, // walk-in snapshot NEVER sets this
    };
    const resolvedRegistrant = resolveBuyerIsVatRegistrant(null, walkInSnapshotParts);
    expect(resolvedRegistrant).toBe(true); // sanity: same as the Tax ID line test

    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 5,
          member: walkInSnapshotParts,
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // Only the seller head-office line — the buyer contributes none, even
    // though buyerIsVatRegistrant (top-level) is true.
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(1);
    expect(text).not.toContain(BRANCH_EN);
    expect(text).not.toContain(BRANCH_TH);
  });

  it('SC-003 gate: a pinned pre-v5 (@v4) document renders NO branch line on EITHER party (byte-stable)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 4,
          member: {
            buyer_is_vat_registrant: true,
            buyer_is_head_office: false,
            buyer_branch_code: BRANCH_CODE,
          },
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // Neither the seller nor the buyer head-office/branch line exists pre-v5.
    expect(countOccurrences(text, HEAD_OFFICE_EN)).toBe(0);
    expect(text).not.toContain(BRANCH_EN);
    expect(text).not.toContain(BRANCH_TH);
  });
});

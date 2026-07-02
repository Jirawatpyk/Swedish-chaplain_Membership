/**
 * 088-invoice-tax-flow-redesign — T035 / T035a [US4] §86/4 presentation polish
 * (FR-009 thousands separators + capitalized English amount-in-words,
 *  FR-010 buyer-block reorder Name → Address → Tax ID → Head Office/Branch,
 *  FR-034 §86/4 particulars wrap / paginate — NEVER silently truncated).
 *
 * ALL of these change the rendered bytes of every tax document, so they are
 * gated behind a NEW template version (`CURRENT_TEMPLATE_VERSION` 5 → 6,
 * `PRESENTATION_POLISH_MIN_VERSION = 6`). A pinned pre-v6 (@v5) render MUST be
 * UNCHANGED — old ungrouped amounts, lowercase words, old buyer order, and the
 * 3-line/5-line ellipsis clips — so already-issued documents reproduce
 * byte-for-length stable (SC-003), exactly like the v3 citation / v4 two-page /
 * v5 branch-line gates.
 *
 * Home = integration (node env): the assertion imports `@react-pdf/renderer`
 * (Node-oriented) + the real render adapter (font registration is heavyweight,
 * matching the sibling `tests/integration/invoicing/*` element-tree renders).
 * No live Neon is touched.
 *
 * Deterministic ELEMENT-TREE assertions (mirrors original-copy /
 * branch-render): `@react-pdf/renderer` maps one PDF page per `<Page>`, and the
 * §86/4 body (amounts, buyer block) lives on every page — so counting text
 * leaves + inspecting a leaf's `style` (StyleSheet.create is identity in v4) is
 * a faithful, parser-free proxy for the rendered output. A closing byte-level
 * test then confirms the separators + capitalization survive the REAL adapter.
 */
import { describe, it, expect } from 'vitest';
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Document, Page, Text } from '@react-pdf/renderer';
import { PDFParse } from 'pdf-parse';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type {
  PdfDocKind,
  PdfRenderInput,
} from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const POLISH_V = 6; // PRESENTATION_POLISH_MIN_VERSION
const PRE_V = 5; // pinned pre-polish (US3 branch-line version)

const BUYER_NAME = 'Acme Co., Ltd.';
const BUYER_ADDR = '99/1 Sukhumvit Rd';
const BUYER_TAX_ID = '1234567890123';
const BRANCH_CODE = '00042';

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
}): PdfRenderInput {
  const docR = DocumentNumber.of('RC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: opts.kind ?? 'invoice',
    templateVersion: opts.templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: BUYER_NAME,
      tax_id: BUYER_TAX_ID,
      address: BUYER_ADDR,
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
      ...opts.member,
    },
    lines: makeLines(),
    // 1,000.00 THB net + 70.00 VAT = 1,070.00 THB total → unambiguous grouping.
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

/** First `<Text>` whose full text content EXACTLY equals `content`. */
function findTextByExactContent(node: ReactNode, content: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const c of node) {
      const found = findTextByExactContent(c, content);
      if (found) return found;
    }
    return null;
  }
  if (isValidElement(node)) {
    if (node.type === Text && collectText(node).join('') === content) return node;
    return findTextByExactContent((node.props as { children?: ReactNode }).children, content);
  }
  return null;
}

/** Merge a react-pdf `style` prop (object OR array of objects) into one record. */
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  return (await parser.getText()).text;
}

describe('088 US4 — §86/4 presentation polish (FR-009 / FR-010 / FR-034)', () => {
  // ---- FR-009: thousands separators + capitalized English amount-in-words ----
  it('AS (a): @v6 amounts carry thousands separators (subtotal 1,000.00 / total 1,070.00)', () => {
    const text = pageText(pagesOf(InvoiceTemplate(makeInput({ templateVersion: POLISH_V })))[0]!);
    expect(text).toContain('1,000.00'); // subtotal grouped
    expect(text).toContain('1,070.00'); // grand total grouped
    // The ungrouped forms must NOT appear at v6.
    expect(text).not.toContain('1000.00');
    expect(text).not.toContain('1070.00');
  });

  it('AS (b): @v6 the English amount-in-words first letter is capitalized', () => {
    const text = pageText(pagesOf(InvoiceTemplate(makeInput({ templateVersion: POLISH_V })))[0]!);
    // amountToEnglishWords(1070) = "one thousand seventy baht" → capitalized.
    expect(text).toContain('(One thousand seventy baht)');
    expect(text).not.toContain('(one thousand seventy baht)');
  });

  // ---- FR-010: buyer identity block order ----
  it('AS (c): @v6 buyer block order is Name → Address → Tax ID → Head Office/Branch', () => {
    const text = pageText(
      pagesOf(
        InvoiceTemplate(
          makeInput({
            templateVersion: POLISH_V,
            member: {
              buyer_is_vat_registrant: true,
              buyer_is_head_office: false,
              buyer_branch_code: BRANCH_CODE,
            },
          }),
        ),
      )[0]!,
    );
    const iName = text.indexOf(BUYER_NAME);
    const iAddr = text.indexOf(BUYER_ADDR);
    const iTaxId = text.indexOf(`Tax ID: ${BUYER_TAX_ID}`);
    // ' / Branch' is unique to the buyer branch line (the seller is 'Head
    // Office'); the bare code '00042' would collide with the doc number
    // RC-2026-000042 in the header.
    const iBranch = text.indexOf(' / Branch');
    expect(iName).toBeGreaterThanOrEqual(0);
    expect(iAddr).toBeGreaterThan(iName);
    expect(iTaxId).toBeGreaterThan(iAddr);
    expect(iBranch).toBeGreaterThan(iTaxId);
  });

  // ---- FR-034: buyer name wraps / paginates — NEVER clipped ----
  it('AS (d): @v6 a 130-char buyer name is NOT clipped (no maxLines/ellipsis) and appears on BOTH Original + Copy pages', () => {
    const LONG_NAME = 'A'.repeat(130); // all-Latin → shapeThai is identity
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: POLISH_V,
          kind: 'receipt_combined',
          member: { legal_name: LONG_NAME, buyer_is_vat_registrant: true },
        }),
      ),
    );
    expect(pages).toHaveLength(2); // Original + Copy (US2)
    for (const p of pages) {
      // Full name present in the tree on each page — nothing dropped.
      expect(pageText(p)).toContain(LONG_NAME);
      // The name leaf carries NO clipping style → wraps/paginates (FR-034).
      const nameEl = findTextByExactContent(p, LONG_NAME);
      expect(nameEl).not.toBeNull();
      const st = flattenStyle((nameEl!.props as { style?: unknown }).style);
      expect(st.maxLines).toBeUndefined();
      expect(st.textOverflow).toBeUndefined();
    }
  });

  // ---- SC-003: a pinned pre-v6 (@v5) render is UNCHANGED ----
  it('SC-003 (e): @v5 amounts stay ungrouped, words lowercase, buyer order Name → Tax ID → Address, name CLIPPED at 3 lines', () => {
    const el = InvoiceTemplate(
      makeInput({
        templateVersion: PRE_V,
        member: {
          buyer_is_vat_registrant: true,
          buyer_is_head_office: false,
          buyer_branch_code: BRANCH_CODE,
        },
      }),
    );
    const text = pageText(pagesOf(el)[0]!);

    // FR-009 NOT applied pre-v6: ungrouped amounts + lowercase words.
    expect(text).toContain('1000.00');
    expect(text).toContain('1070.00');
    expect(text).not.toContain('1,000.00');
    expect(text).toContain('(one thousand seventy baht)');
    expect(text).not.toContain('(One thousand seventy baht)');

    // FR-010 NOT applied pre-v6: legacy order Name → Tax ID → Address → Branch.
    const iName = text.indexOf(BUYER_NAME);
    const iTaxId = text.indexOf(`Tax ID: ${BUYER_TAX_ID}`);
    const iAddr = text.indexOf(BUYER_ADDR);
    expect(iName).toBeGreaterThanOrEqual(0);
    expect(iTaxId).toBeGreaterThan(iName);
    expect(iAddr).toBeGreaterThan(iTaxId);

    // FR-034 clip PRESERVED pre-v6: buyer name uses maxLines:3 + ellipsis.
    const nameEl = findTextByExactContent(pagesOf(el)[0]!, BUYER_NAME);
    expect(nameEl).not.toBeNull();
    const st = flattenStyle((nameEl!.props as { style?: unknown }).style);
    expect(st.maxLines).toBe(3);
    expect(st.textOverflow).toBe('ellipsis');
  });

  // ---- SC-004 (bytes): the polish survives the REAL adapter render ----
  it('SC-004 (bytes): the REAL @v6 render carries "1,070.00" + "One thousand seventy baht"; @v5 carries "1070.00" + lowercase words', async () => {
    const v6 = await reactPdfRenderAdapter.render(makeInput({ templateVersion: POLISH_V }));
    const v6Text = await extractPdfText(v6.bytes);
    expect(v6Text).toContain('1,070.00');
    expect(v6Text).toContain('One thousand seventy baht');

    const v5 = await reactPdfRenderAdapter.render(makeInput({ templateVersion: PRE_V }));
    const v5Text = await extractPdfText(v5.bytes);
    expect(v5Text).toContain('1070.00');
    expect(v5Text).not.toContain('1,070.00');
    expect(v5Text).toContain('one thousand seventy baht');
  }, 60_000);
});

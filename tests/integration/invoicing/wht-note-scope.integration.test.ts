/**
 * 088-invoice-tax-flow-redesign — T038 [US5] Tenant-configurable footer + WHT
 * note + offline-payment bank block (FR-012 / FR-022 / SC-007).
 *
 * SC-007: the withholding-tax (WHT) note renders on **membership documents only**
 * (BOTH the ใบแจ้งหนี้ bill AND the ใบกำกับภาษี/ใบเสร็จรับเงิน tax receipt), NEVER
 * on event documents, and ONLY for a tenant that configured one — and the old
 * hardcoded "Rendered by Chamber-OS (§-citation)" footer is gone at v7.
 *
 * FR-022: the offline-payment bank block + "Issued by / Received by / Date"
 * signature fields render on the **ใบแจ้งหนี้ ONLY** (never the paid tax receipt).
 *
 * SC-003 (byte-determinism): all US5 render changes gate on `templateVersion >= 7`
 * (bumped CURRENT_TEMPLATE_VERSION 6→7). A pinned pre-v7 document renders NO WHT
 * note + NO bank block AND keeps the legacy "Rendered by Chamber-OS" citation
 * footer — asserted below — so already-issued documents re-render byte-stable.
 *
 * Deterministic ELEMENT-TREE assertion (mirrors branch-render.integration.test.ts):
 * `@react-pdf/renderer` maps one PDF page per `<Page>`. No live Neon — the WHT
 * note + bank block ride the pinned `TenantIdentitySnapshot`, so this test drives
 * `InvoiceTemplate(input)` directly with the snapshot fields populated.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import {
  InvoiceTemplate,
  WHT_NOTE_WRAP_THRESHOLD_CHARS,
} from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
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

const WHT_NOTE_TH =
  'หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย';
const WHT_NOTE_EN =
  'No deduction of withholding tax shall apply, as the income is exempt from income tax.';
const LEGACY_FOOTER = 'Rendered by Chamber-OS';

const BANK_PAYEE = 'Thai-Swedish Chamber of Commerce';
const BANK_ACCOUNT_NO = '005-3-92003-9';
const BANK_SWIFT = 'KASITHBK';
const BANK_INSTRUCTIONS_EN =
  "If you pay by cheque, make it 'Account Payee Only'. All bank fees to be covered by the payer.";
// Fix#12 companions — the single inner-only bank value each solo-field case pins.
const BANK_ACCOUNT_TYPE_ONLY = 'Current Account';
const BANK_ADDRESS_ONLY = 'KBank Ratchada Branch, Bangkok 10310';

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

/** A tenant snapshot with the US5 WHT note + bank block populated. */
function tenantWithNoteAndBank(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    wht_note_th: WHT_NOTE_TH,
    wht_note_en: WHT_NOTE_EN,
    bank_payee_name: BANK_PAYEE,
    bank_account_no: BANK_ACCOUNT_NO,
    bank_account_type: 'Savings',
    bank_name: 'Kasikorn Bank',
    bank_branch: 'Emquartier',
    bank_address: 'Emquartier Bldg, 3rd Fl, Sukhumvit 35, Bangkok 10110',
    bank_swift: BANK_SWIFT,
    payment_instructions_th: 'ชำระโดยเช็คขีดคร่อม A/C Payee Only',
    payment_instructions_en: BANK_INSTRUCTIONS_EN,
  };
}

/**
 * Fix #12 (whole-feature review) — a tenant that configured ONLY `bank_branch`
 * and left every OTHER bank field null. The outer bank-block visibility gate
 * historically checked only 6 fields (payee/account_no/name/swift/instructions
 * th+en) but RENDERS 3 more inside (bank_branch, bank_account_type,
 * bank_address). With all 6 gate fields null, the whole block was suppressed and
 * the admin-entered branch never printed. The block MUST render when ANY bank
 * field is present.
 */
function tenantWithOnlyBankBranch(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    wht_note_th: null,
    wht_note_en: null,
    // Every OUTER-GATE bank field is null …
    bank_payee_name: null,
    bank_account_no: null,
    bank_name: null,
    bank_swift: null,
    payment_instructions_th: null,
    payment_instructions_en: null,
    // … only bank_branch is configured.
    bank_branch: 'Ratchada Branch',
  };
}

/**
 * Fix #12 companions — tenants that configured ONLY `bank_account_type` (resp.
 * `bank_address`) and left every OTHER bank field null. Each pins the OTHER two
 * inner gate lines Fix #12 added (invoice-template.tsx:739-741) so a revert of
 * EITHER `bank_account_type != null ||` or `bank_address != null ||` would
 * suppress the whole block and fail here — not just the `bank_branch` line the
 * sibling test above covers.
 */
function tenantWithOnlyBankAccountType(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    wht_note_th: null,
    wht_note_en: null,
    bank_payee_name: null,
    bank_account_no: null,
    bank_name: null,
    bank_swift: null,
    payment_instructions_th: null,
    payment_instructions_en: null,
    // … only bank_account_type is configured.
    bank_account_type: BANK_ACCOUNT_TYPE_ONLY,
  };
}

function tenantWithOnlyBankAddress(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    wht_note_th: null,
    wht_note_en: null,
    bank_payee_name: null,
    bank_account_no: null,
    bank_name: null,
    bank_swift: null,
    payment_instructions_th: null,
    payment_instructions_en: null,
    // … only bank_address is configured.
    bank_address: BANK_ADDRESS_ONLY,
  };
}

/** A tenant snapshot with NO WHT note + NO bank block. */
function tenantWithoutNote(): TenantIdentitySnapshot {
  return {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
    tax_id: '0994000187203',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
    wht_note_th: null,
    wht_note_en: null,
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
    // exactOptionalPropertyTypes — only set billMode when defined (never undefined).
    ...(opts.billMode !== undefined ? { billMode: opts.billMode } : {}),
    tenant: opts.tenant ?? tenantWithNoteAndBank(),
    member: {
      legal_name: 'Acme Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    },
    // 059 / PR-A Task 6b — irrelevant to this file's subject (the WHT note
    // gate); `true` matches the fixture's own `tax_id` presence.
    buyerIsVatRegistrant: true,
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

describe('088 US5 — WHT note scope (FR-012 / SC-007)', () => {
  it('AS1: WHT note renders on a membership ใบแจ้งหนี้ (bill) + old Chamber-OS footer is GONE (v7)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'invoice',
          billMode: true,
          invoiceSubject: 'membership',
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).toContain(shapeThai(WHT_NOTE_TH));
    expect(text).toContain(WHT_NOTE_EN);
    expect(text).not.toContain(LEGACY_FOOTER);
  });

  it('AS1: WHT note renders on the membership tax receipt — on BOTH Original + Copy pages (v7)', () => {
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'receipt_combined',
          invoiceSubject: 'membership',
        }),
      ),
    );
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      const text = pageText(p);
      expect(text).toContain(shapeThai(WHT_NOTE_TH));
      expect(text).toContain(WHT_NOTE_EN);
      expect(text).not.toContain(LEGACY_FOOTER);
    }
  });

  it('AS2: WHT note does NOT render on an EVENT document (v7)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'invoice',
          billMode: true,
          invoiceSubject: 'event',
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).not.toContain(shapeThai(WHT_NOTE_TH));
    expect(text).not.toContain(WHT_NOTE_EN);
  });

  it('AS3: a tenant with NO note configured renders a clean footer (no stray note, no Chamber-OS) (v7)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'receipt_combined',
          invoiceSubject: 'membership',
          tenant: tenantWithoutNote(),
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).not.toContain(shapeThai(WHT_NOTE_TH));
    expect(text).not.toContain(WHT_NOTE_EN);
    expect(text).not.toContain(LEGACY_FOOTER);
  });

  it('SC-003: a pinned pre-v7 (@v6) membership receipt renders NO WHT note AND keeps the legacy Chamber-OS citation footer (byte-stable)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 6,
          kind: 'receipt_combined',
          invoiceSubject: 'membership',
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).not.toContain(shapeThai(WHT_NOTE_TH));
    expect(text).not.toContain(WHT_NOTE_EN);
    // Pre-v7 keeps the historical footer.
    expect(text).toContain(LEGACY_FOOTER);
  });

  // 093-wht-note-pdf-wrap — the full-width WHT-note block gets a wider Thai wrap
  // budget (WHT_NOTE_WRAP_THRESHOLD_CHARS = 72) so the ~68-char accountant note
  // renders on ONE line instead of being force-wrapped onto two by the global
  // shapeThai default (55). Gated at templateVersion >= 9 for SC-003.
  it('093: at v9 the membership tax receipt renders the WHT note on ONE line (both Original + Copy)', () => {
    const oneLine = shapeThai(WHT_NOTE_TH, WHT_NOTE_WRAP_THRESHOLD_CHARS);
    // Sanity: the wider budget really keeps this note single-line.
    expect(oneLine).not.toContain('\n');
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 9,
          kind: 'receipt_combined',
          invoiceSubject: 'membership',
        }),
      ),
    );
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      const text = pageText(p);
      expect(text).toContain(oneLine);
      expect(text).toContain(WHT_NOTE_EN);
    }
  });

  it('093 SC-003: a pinned pre-v9 (@v7 + @v8) membership document STILL wraps the WHT note (byte-reproduce)', () => {
    const wrapped = shapeThai(WHT_NOTE_TH); // legacy default-55 budget → two lines
    // Sanity: the legacy budget wraps this note (so the assertion below has teeth).
    expect(wrapped).toContain('\n');
    for (const v of [7, 8]) {
      const page = pagesOf(
        InvoiceTemplate(
          makeInput({
            templateVersion: v,
            kind: 'invoice',
            billMode: true,
            invoiceSubject: 'membership',
          }),
        ),
      )[0]!;
      expect(pageText(page)).toContain(wrapped);
    }
  });
});

describe('088 US5 — offline-payment bank block (FR-022)', () => {
  it('renders the bank block + Issued by/Received by/Date on the ใบแจ้งหนี้ (bill) at v7', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'invoice',
          billMode: true,
          invoiceSubject: 'membership',
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).toContain(BANK_PAYEE);
    expect(text).toContain(BANK_ACCOUNT_NO);
    expect(text).toContain(BANK_SWIFT);
    expect(text).toContain(BANK_INSTRUCTIONS_EN);
    // Layout-only signature stamp labels (bilingual — English gloss asserted).
    expect(text).toContain('Issued by');
    expect(text).toContain('Received by');
    expect(text).toContain('Date');
  });

  it('Fix#12: a v7 bill whose tenant set ONLY bank_branch (all 6 gate fields null) STILL renders the bank block', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'invoice',
          billMode: true,
          invoiceSubject: 'membership',
          tenant: tenantWithOnlyBankBranch(),
        }),
      ),
    )[0]!;
    const text = pageText(page);
    // The block header + the admin-entered branch value BOTH render.
    expect(text).toContain('Payment Details');
    expect(text).toContain(shapeThai('สาขา'));
    expect(text).toContain('Ratchada Branch');
  });

  // Fix #12 — the sibling above pins only the `bank_branch` gate line; these two
  // pin the OTHER two inner fields added to the outer visibility gate so a revert
  // of either would suppress the whole block and fail here. `bank_address` renders
  // via `shapeThai(...)` (invoice-template.tsx:778) so its value is asserted
  // shaped; `bank_account_type` renders raw (line 765).
  it.each([
    {
      name: 'bank_account_type',
      tenant: tenantWithOnlyBankAccountType(),
      label: shapeThai('ประเภทบัญชี'),
      value: BANK_ACCOUNT_TYPE_ONLY,
    },
    {
      name: 'bank_address',
      tenant: tenantWithOnlyBankAddress(),
      label: shapeThai('ที่อยู่ธนาคาร'),
      value: shapeThai(BANK_ADDRESS_ONLY),
    },
  ])(
    'Fix#12: a v7 bill whose tenant set ONLY $name (all other bank fields null) STILL renders the bank block',
    ({ tenant, label, value }) => {
      const page = pagesOf(
        InvoiceTemplate(
          makeInput({
            templateVersion: 7,
            kind: 'invoice',
            billMode: true,
            invoiceSubject: 'membership',
            tenant,
          }),
        ),
      )[0]!;
      const text = pageText(page);
      // The block header + the sole admin-entered value BOTH render.
      expect(text).toContain('Payment Details');
      expect(text).toContain(label);
      expect(text).toContain(value);
    },
  );

  it('does NOT render the bank block on the paid tax receipt (receipt_combined) at v7', () => {
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 7,
          kind: 'receipt_combined',
          invoiceSubject: 'membership',
        }),
      ),
    );
    for (const p of pages) {
      const text = pageText(p);
      expect(text).not.toContain(BANK_ACCOUNT_NO);
      expect(text).not.toContain(BANK_SWIFT);
      expect(text).not.toContain('Received by');
    }
  });

  it('SC-003: a pinned pre-v7 (@v6) bill renders NO bank block (byte-stable)', () => {
    const page = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: 6,
          kind: 'invoice',
          billMode: true,
          invoiceSubject: 'membership',
        }),
      ),
    )[0]!;
    const text = pageText(page);
    expect(text).not.toContain(BANK_ACCOUNT_NO);
    expect(text).not.toContain(BANK_SWIFT);
    expect(text).not.toContain('Received by');
  });
});

/**
 * 059-member-tax-correctness / PR-A Task 6a — the BUYER Tax ID line is a §86/4
 * particular of a VAT REGISTRANT ONLY (ประกาศอธิบดีฯ ฉบับที่ 196).
 *
 * Pre-v11 the template printed ANY non-blank `tax_id`, with no registrant check.
 * That became unsafe the moment `members.tax_id` began accepting a foreign
 * natural person's PASSPORT / work-permit number (they have no Thai TIN): their
 * identifier would have been printed on a legal tax document as a taxpayer
 * number — a FALSE PARTICULAR. From v11 the line requires
 * `buyer_is_vat_registrant === true` on the pinned snapshot.
 *
 * THE VERSION GATE IS THE POINT OF THIS FILE.
 *
 * An issued PDF is NOT write-once. `void-invoice.ts` and `issue-credit-note.ts`
 * (the credited-annotation overlay) both RE-RENDER with the currently deployed
 * template code against the FROZEN snapshot, at the document's PINNED
 * `templateVersion`, and re-upload to the SAME blobKey (`allowOverwrite: true`).
 * And `member-identity-snapshot.ts` declares `buyer_is_vat_registrant` as
 * `.optional().default(false)` — so EVERY snapshot written before that field
 * existed omits the key and reads back FALSE.
 *
 * Un-gated, this change would therefore have silently ERASED the Tax ID line
 * from an already-issued §86/4 tax invoice the moment someone voided or
 * credit-noted it. The v10-pinned test below is that exact regression, and
 * without it the gate would be decoration.
 *
 * Deterministic ELEMENT-TREE assertion (mirrors branch-render.integration.test.ts):
 * `@react-pdf/renderer` maps one PDF page per `<Page>`, and the §86/4 buyer block
 * lives on every page. No live Neon is touched.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { resolveBuyerIsVatRegistrant } from '@/modules/invoicing/domain/document-kind';
import type { PdfDocKind, PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

/** TAX_ID_REGISTRANT_GATE_MIN_VERSION (invoice-template.tsx). */
const GATE_V = 11;
/** The last version that prints a buyer TIN unconditionally. */
const PRE_V = 10;

/**
 * A juristic person's Thai TIN. SYNTHETIC, but the 13-digit weighted CHECK DIGIT
 * is genuinely correct — which is load-bearing here, because the v11 gate keys
 * on exactly that. The old fixture (`1234567890123`) does NOT pass the checksum,
 * so under the current rule it would suppress the line and every "must print"
 * assertion would fail — while every "must not print" assertion would pass FOR
 * THE WRONG REASON. Never put a checksum-invalid string in this file.
 */
const BUYER_TIN = '0105551234567';
/**
 * A Thai NATURAL PERSON's taxpayer number — i.e. their 13-digit national ID.
 * Synthetic; checksum genuinely valid.
 *
 * In Thailand an individual's TIN IS their national ID, so this is a real
 * taxpayer number and it MUST print: a บุคคลธรรมดา needs it on the document to
 * claim their personal income-tax deduction. They are not a VAT registrant, so
 * the first version of the v11 gate erased it from their own receipt.
 */
const INDIVIDUAL_NATIONAL_ID = '1102000987653';
/**
 * A foreign natural person's identifier. Not a Thai TIN, not a VAT registration
 * — and non-blank, which is ALL the pre-v11 template checked.
 */
const PASSPORT = 'AA1234567';
/**
 * A foreign company-registration number: 13 characters, all digits, and yet NOT
 * a Thai TIN — the check digit does not hold. This is the case that proves the
 * gate is doing arithmetic and not merely counting characters.
 */
const FOREIGN_ORG_NUMBER = '1234567890123';

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
   * 059 / PR-A Task 6b — the RESOLVED top-level field `buyerTaxIdEl` now reads.
   * Defaults to the snapshot's OWN `buyer_is_vat_registrant` flag, matching
   * every test in this file written before Task 6b (which modelled the buyer
   * generically, with no matched-member/walk-in distinction). The Task 6b
   * regression test below overrides this explicitly with the REAL resolver's
   * output for a walk-in, while the snapshot's own flag stays at its real
   * (always-false) walk-in value — that mismatch IS the bug being proven.
   */
  buyerIsVatRegistrant?: boolean;
}): PdfRenderInput {
  const docR = DocumentNumber.of('RC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const member = {
    legal_name: 'Acme Co., Ltd.',
    tax_id: BUYER_TIN,
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
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      // The SELLER TIN is unconditional (the seller is always the registrant
      // issuing the document) and is rendered behind a Thai prefix, so the
      // buyer-specific assertions below anchor on the bare `Tax ID: <value>`.
      tax_id: '0994000187203',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member,
    buyerIsVatRegistrant: opts.buyerIsVatRegistrant ?? member.buyer_is_vat_registrant === true,
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

function firstPageText(input: PdfRenderInput): string {
  return pageText(pagesOf(InvoiceTemplate(input))[0]!);
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

/**
 * The SELLER's TIN line renders unconditionally on every tax document (the
 * seller IS the registrant issuing it) and its label ends in the same
 * `Tax ID: ` string as the buyer's. So `Tax ID: ` alone is NOT a buyer-specific
 * needle — the seller always contributes exactly ONE. The buyer's line, when it
 * prints, makes TWO. Assert on this, or on the buyer's literal value.
 */
const SELLER_ONLY = 1;
const SELLER_AND_BUYER = 2;
const TAX_ID_LABEL = 'Tax ID: ';

describe('059 Task 6a — buyer Tax ID prints only for a VAT registrant (v11 gate)', () => {
  it('v11 + REGISTRANT buyer → the Tax ID line prints (§86/4 particular, ประกาศ 196)', () => {
    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: { tax_id: BUYER_TIN, buyer_is_vat_registrant: true },
      }),
    );
    expect(text).toContain(`Tax ID: ${BUYER_TIN}`);
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_AND_BUYER);
  });

  it('v11 + a NATURAL PERSON (not VAT-registered) → their national ID DOES print', () => {
    // The maintainer found this by looking at a real document. In Thailand an
    // individual's taxpayer number IS their 13-digit national ID, so printing it
    // under the label "Tax ID" is TRUE — and the บุคคลธรรมดา needs it there, to
    // claim the personal income-tax deduction the document exists for.
    //
    // The first version of this gate keyed on VAT-REGISTRANT status, which no
    // natural person has, and so erased their own tax number from their own
    // receipt. The rule is "is this a real Thai TIN", not "is this buyer a
    // registrant".
    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: {
          tax_id: INDIVIDUAL_NATIONAL_ID,
          buyer_is_vat_registrant: false,
        },
      }),
    );
    expect(text).toContain(`Tax ID: ${INDIVIDUAL_NATIONAL_ID}`);
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_AND_BUYER);
  });

  it('v11 + a 13-DIGIT FOREIGN number that fails the check digit → NO buyer Tax ID line', () => {
    // The gate does ARITHMETIC, not character-counting. A 13-digit foreign
    // registration number looks exactly like a Thai TIN until you compute the
    // weighted check digit — and then it does not. Printing it as "Tax ID" would
    // assert a Thai taxpayer number that does not exist.
    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: {
          tax_id: FOREIGN_ORG_NUMBER,
          buyer_is_vat_registrant: false,
        },
      }),
    );
    expect(text).not.toContain(`Tax ID: ${FOREIGN_ORG_NUMBER}`);
    // Only the SELLER's TIN line survives.
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_ONLY);
    // The buyer block still rendered (making the negative conclusive).
    expect(text).toContain('Acme Co., Ltd.');
  });

  it('v11 + NON-registrant buyer holding a PASSPORT → the passport NEVER reaches the tax document', () => {
    // THE WHOLE POINT. A foreign natural person has no Thai TIN; the maintainer
    // decided to let them store a passport / work-permit number in `tax_id`. It
    // must not be printed as a taxpayer number on a legal tax document.
    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: { tax_id: PASSPORT, buyer_is_vat_registrant: false },
      }),
    );
    expect(text).not.toContain(PASSPORT);
    // Only the SELLER's TIN line survives — the buyer contributes none.
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_ONLY);
    expect(text).toContain('Acme Co., Ltd.');
  });

  it('v11 — the registrant flag does NOT gate the Tax ID line; a real Thai TIN prints either way', () => {
    // The two buyer particulars answer two DIFFERENT questions, and this test
    // exists to keep them apart:
    //
    //   Tax ID line          → "is this string a real Thai TIN?"  (ประกาศ 196)
    //   สำนักงานใหญ่/สาขา line → "is this buyer a VAT registrant?" (ประกาศ 199)
    //
    // A 13-digit number cannot answer the second — a natural person's national ID
    // is 13 digits too. Conflating them is what erased a บุคคลธรรมดา's own tax
    // number from their own document. So: same TIN, all three flag states, and
    // the Tax ID line prints in every one.
    for (const flag of [true, false, undefined]) {
      const text = firstPageText(
        makeInput({
          templateVersion: GATE_V,
          member: {
            tax_id: BUYER_TIN,
            ...(flag === undefined ? {} : { buyer_is_vat_registrant: flag }),
          },
        }),
      );
      expect(text).toContain(`Tax ID: ${BUYER_TIN}`);
      expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_AND_BUYER);
    }
  });

  // ── THE REGRESSION THE GATE EXISTS TO PREVENT ────────────────────────────
  it('SC-003: a v10-PINNED document with a tax_id and buyer_is_vat_registrant=false STILL prints its Tax ID line', () => {
    // This is the void / credit-note re-render path. The document was ISSUED at
    // v10, when the Tax ID line printed unconditionally — so its original bytes
    // CONTAIN it. Its snapshot pre-dates `buyer_is_vat_registrant`, so the field
    // reads back as the zod `.default(false)`.
    //
    // Without the version gate, voiding or credit-noting this already-issued
    // §86/4 tax invoice would RE-RENDER it (currently-deployed template, pinned
    // version, same blobKey, allowOverwrite) and SILENTLY DELETE the Tax ID line
    // from a legal document that legitimately carried one. The gate is what makes
    // the re-render reproduce the original.
    const text = firstPageText(
      makeInput({
        templateVersion: PRE_V,
        member: { tax_id: BUYER_TIN, buyer_is_vat_registrant: false },
      }),
    );
    expect(text).toContain(`Tax ID: ${BUYER_TIN}`);
  });

  it('SC-003: a v10-pinned snapshot that OMITS the flag entirely also still prints its Tax ID line', () => {
    const text = firstPageText(
      makeInput({ templateVersion: PRE_V, member: { tax_id: BUYER_TIN } }),
    );
    expect(text).toContain(`Tax ID: ${BUYER_TIN}`);
  });

  it('a blank / null tax_id renders no BUYER line at ANY version (buyerHasTin, unchanged)', () => {
    // Even for a REGISTRANT: `buyerHasTin` still gates "is there a number to
    // print". The registrant flag narrows the line; it never conjures one.
    for (const v of [PRE_V, GATE_V]) {
      const nullText = firstPageText(
        makeInput({
          templateVersion: v,
          member: { tax_id: null, buyer_is_vat_registrant: true },
        }),
      );
      expect(
        countOccurrences(nullText, TAX_ID_LABEL),
        `v${v}: null tax_id → seller line only`,
      ).toBe(SELLER_ONLY);

      const blankText = firstPageText(
        makeInput({
          templateVersion: v,
          member: { tax_id: '   ', buyer_is_vat_registrant: true },
        }),
      );
      expect(
        countOccurrences(blankText, TAX_ID_LABEL),
        `v${v}: whitespace tax_id → seller line only`,
      ).toBe(SELLER_ONLY);
    }
  });

  it('the gate applies on BOTH pages of a two-page combined receipt (the block lives in renderPageBody)', () => {
    const pages = pagesOf(
      InvoiceTemplate(
        makeInput({
          templateVersion: GATE_V,
          kind: 'receipt_combined',
          member: { tax_id: PASSPORT, buyer_is_vat_registrant: false },
        }),
      ),
    );
    expect(pages).toHaveLength(2); // Original + สำเนา (Copy)
    for (const p of pages) {
      expect(pageText(p)).not.toContain(PASSPORT);
    }
  });

  it('CURRENT_TEMPLATE_VERSION is at/after the gate — every NEW issuance applies the registrant rule', () => {
    expect(CURRENT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(GATE_V);
  });
});

describe('059 Task 6b — WALK-IN buyer: the resolver that classed this document must be what prints', () => {
  // BUG regression (found by Thai-tax-compliance audit of d3497ea0): Guard 1 (the
  // document CLASS) and Guard 2 (the Tax ID LINE) were reading two DIFFERENT
  // sources of truth for a walk-in (non-member) buyer.
  //
  //   Guard 1 — `resolveBuyerIsVatRegistrant(memberId=null, snapshot)` infers
  //     registrant status from TIN-PRESENCE for a walk-in (there is no `members`
  //     row to read a recorded flag from). THIS is what chose `kind: 'invoice'`
  //     for the document below.
  //   Guard 2 (pre-fix) — `invoice-template.tsx` read
  //     `input.member.buyer_is_vat_registrant` straight off the frozen snapshot.
  //     `create-event-invoice-draft.ts` NEVER sets that field on a walk-in
  //     snapshot (by design — see document-kind.ts), so it is ALWAYS the zod
  //     default `false` for a walk-in, regardless of what Guard 1 decided.
  //
  // Net effect pre-fix: a walk-in whose OWN 13-digit TIN classified the document
  // as a §86/4 tax invoice got that exact TIN silently dropped from the line
  // printed for the input-VAT claim it was supplied to make.
  it('BUG regression: a walk-in whose 13-digit TIN classed the document as invoice must see that TIN print', () => {
    // A walk-in's snapshot NEVER carries `buyer_is_vat_registrant=true` — this is
    // the exact shape `create-event-invoice-draft.ts` produces for a non-member
    // buyer (the field is omitted; zod resolves it to `false`).
    const walkInSnapshotParts = {
      tax_id: BUYER_TIN,
      buyer_is_vat_registrant: false as const,
    };
    // Sanity — this is the REAL resolver, and it is what chose `kind: 'invoice'`
    // for this exact document (the walk-in branch infers from TIN-presence).
    const resolvedRegistrant = resolveBuyerIsVatRegistrant(null, walkInSnapshotParts);
    expect(resolvedRegistrant).toBe(true);

    // The render input carries the RESOLVED value at the top level (what every
    // real call site threads via `resolveBuyerIsVatRegistrant`) — this is the
    // join: Guard 1's decision is what Guard 2 must read, NOT the snapshot's own
    // (always-false-for-a-walk-in) flag.
    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: walkInSnapshotParts,
        buyerIsVatRegistrant: resolvedRegistrant,
      }),
    );
    // The buyer supplied this exact TIN to claim input VAT on the §86/4 tax
    // invoice their own TIN produced — it must print.
    expect(text).toContain(`Tax ID: ${BUYER_TIN}`);
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_AND_BUYER);
  });

  it('a matched member holding a PASSPORT still gets NO Tax ID line at v11 (the original point of the gate survives)', () => {
    // The gate's original purpose — a foreign natural person's passport must
    // never print as a taxpayer number — is unaffected by the later correction
    // that lets a Thai natural person's national ID through. A passport fails
    // the 13-digit check digit (it is not even 13 digits), so it is suppressed
    // whatever the registrant flag says.
    //
    // NOTE the fixture: this test used to seed a 13-digit number and rely on the
    // REGISTRANT flag to suppress it. That number is now a checksum-valid Thai
    // TIN and prints — correctly. Seeding a passport is what actually exercises
    // the rule this test is named for.
    const matchedMemberId = '00000000-0000-0000-0000-0000000000b2';
    const matchedNonRegistrantSnapshot = {
      tax_id: PASSPORT,
      buyer_is_vat_registrant: false as const,
    };
    const resolvedRegistrant = resolveBuyerIsVatRegistrant(
      matchedMemberId,
      matchedNonRegistrantSnapshot,
    );
    expect(resolvedRegistrant).toBe(false);

    const text = firstPageText(
      makeInput({
        templateVersion: GATE_V,
        member: matchedNonRegistrantSnapshot,
        buyerIsVatRegistrant: resolvedRegistrant,
      }),
    );
    expect(text).not.toContain(PASSPORT);
    expect(countOccurrences(text, TAX_ID_LABEL)).toBe(SELLER_ONLY);
  });
});

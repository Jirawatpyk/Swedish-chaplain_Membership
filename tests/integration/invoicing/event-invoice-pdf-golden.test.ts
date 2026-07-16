/**
 * 054-event-fee-invoices (Task 9) — event-invoice PDF golden test.
 *
 * Pins the §86/4 doc-type render contract on the EVENT-fee PDF, end-to-end
 * through the REAL `reactPdfRenderAdapter` (decompressed text extracted via
 * pdf-parse). Two cases, both Model B (VAT-INCLUSIVE line = all-in ticket):
 *
 *   (i)  event + buyer TIN (matched-member shape) →
 *          title "ใบกำกับภาษี / Tax Invoice"
 *          event_fee line description present
 *          line amount = inclusive 1,070.00; subtotal 1,000 / VAT 70 / total 1,070
 *          "ราคารวมภาษีมูลค่าเพิ่มแล้ว / VAT included" annotation present
 *          buyer Tax ID line present
 *
 *   (ii) event + NO buyer TIN (non-member walk-in) →
 *          title "ใบเสร็จรับเงิน / Official Receipt"
 *          same amounts + VAT-included annotation
 *          NO buyer Tax ID line (the §105 receipt buyer has no TIN)
 *
 * Why a render adapter golden (not a use-case integration): the title switch
 * + VAT-included annotation live in the TEMPLATE, driven by `kind` +
 * `vatInclusive` on `PdfRenderInput`. The issue-invoice → render-input WIRING
 * (which kind is chosen from subject + buyer TIN) is pinned separately in
 * `issue-event-invoice.test.ts`. This test pins the TEMPLATE side: given the
 * input issue-invoice builds, the bytes carry the right legal labels.
 *
 * Mirrors `credit-note-pdf-golden.test.ts`'s render-spy posture but renders
 * REAL bytes because the assertion is about glyphs the template emits, not the
 * structured render-input arguments.
 *
 * No DB for the 054/Task-12 sections — pure render-input → bytes → text;
 * they live in tests/integration/** only because react-pdf font registration
 * + pdf-parse are heavyweight. The 064 Task 14 section at the END of the file
 * DOES hit live Neon: it runs the REAL chain (createEventInvoiceDraft →
 * issueEventInvoiceAsPaid with the real render adapter) and pins the as-paid
 * document bytes.
 *
 * Thai-shaping note: `shapeThai` decomposes sara-am (ำ U+0E33 → ◌ํ + า) and
 * injects ZWSP break points, so extracted Thai text can differ from the i18n
 * source code point sequence. The "ใบกำกับภาษี" matcher tolerates both the
 * composed (ำ) and decomposed (ํา) forms exactly as the e2e PDF assertion does.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { runInTenant } from '@/lib/db';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueEventInvoiceAsPaid,
  type IssueEventInvoiceAsPaidDeps,
} from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { recipientLocaleAdapter } from '@/modules/invoicing/infrastructure/adapters/recipient-locale-adapter';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

/** Single Model-B event_fee line — unitPrice === total === inclusive satang. */
function makeEventLine(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000e1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      // 1,070.00 THB inclusive — the canonical 1,000 net + 70 VAT case.
      unitPrice: Money.fromSatangUnsafe(107_000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(107_000n),
      position: 1,
    },
  ];
}

/**
 * Build the render input exactly as `issue-invoice` does for an EVENT (Model B,
 * vatInclusive=true): the line carries the GROSS amount, subtotal/vat are the
 * back-calculated split (1,070 incl @ 7% → 1,000 net + 70 VAT).
 */
function makeEventRenderInput(opts: {
  kind: 'invoice' | 'receipt_separate';
  buyerTaxId: string | null;
}): PdfRenderInput {
  const docR = DocumentNumber.of('EVT', 2026, 7);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: opts.kind,
    templateVersion: 1,
    documentNumber: docR.value,
    issueDate: '2026-09-10',
    dueDate: '2026-09-10',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: opts.buyerTaxId ? 'Beta Imports Ltd' : 'Walk-in Guest',
      tax_id: opts.buyerTaxId,
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@beta.example',
      // 055-member-number — event buyer has no member number → both the bare
      // integer and the formatted display string are null → no Member No. line.
      member_number: null,
      member_number_display: null,
    },
    // 059 / PR-A Task 6b — mirrors `resolveBuyerIsVatRegistrant`'s WALK-IN
    // branch (TIN-presence): this fixture always models a non-member event
    // buyer ("Walk-in Guest" when `buyerTaxId` is null).
    lines: makeEventLine(),
    subtotal: Money.fromSatangUnsafe(100_000n), // 1,000.00 net
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n), // 70.00 VAT
    total: Money.fromSatangUnsafe(107_000n), // 1,070.00 gross
    vatInclusive: true,
  };
}

describe('054 Task 9 — event-invoice PDF golden (§86/4 doc-type render)', () => {
  it('(i) event + buyer TIN → title ใบกำกับภาษี / Tax Invoice, inclusive line + amounts + VAT-included annotation + buyer Tax ID', async () => {
    const input = makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' });
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Title — full tax invoice. Thai "ใบกำกับภาษี" may extract with sara-am
    // decomposed (ํา) per shapeThai; tolerate both forms + an optional ZWSP.
    expect(text, 'expected Thai full-tax-invoice title ใบกำกับภาษี').toMatch(
      /ใบก[ำํ]​?า?กับภาษี/,
    );
    expect(text, 'expected English "Tax Invoice"').toMatch(/Tax Invoice/i);
    // MUST NOT carry the receipt title.
    expect(text).not.toMatch(/Official Receipt/i);

    // Event_fee line description rendered (English token is sara-am-free).
    expect(text).toContain('Annual Gala');
    expect(text).toContain('2026-09-10');

    // Amounts: inclusive line 1,070.00 + back-calculated subtotal/VAT/total.
    expect(text).toContain('1070.00'); // line total === grand total (Model B)
    expect(text).toContain('1000.00'); // net subtotal
    expect(text).toContain('70.00'); // VAT

    // VAT-included annotation (English token is sara-am-free → matches verbatim).
    expect(text, 'expected "VAT included" annotation on a VAT-inclusive doc').toMatch(
      /VAT included/i,
    );

    // §86/4 — a full tax invoice carries the buyer's Tax ID.
    expect(text).toContain('9876543210123');
  }, 60_000);

  it('(ii) event + NO buyer TIN → title ใบเสร็จรับเงิน / Official Receipt, same amounts + VAT-included annotation, NO buyer Tax ID line', async () => {
    const input = makeEventRenderInput({ kind: 'receipt_separate', buyerTaxId: null });
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Title — §105 official receipt. "ใบเสร็จรับเงิน" has no sara-am → extracts
    // cleanly (modulo a possible trailing ZWSP, which a substring match ignores).
    expect(text, 'expected Thai receipt title ใบเสร็จรับเงิน').toContain('ใบเสร็จรับเงิน');
    expect(text, 'expected English "Official Receipt"').toMatch(/Official Receipt/i);
    // MUST NOT carry the full-tax-invoice title (a TIN-less buyer cannot get a
    // §86/4 ใบกำกับภาษี — the ship-blocker this whole task closes).
    expect(text).not.toMatch(/Tax Invoice/i);

    // Same Model-B amounts as the tax-invoice case.
    expect(text).toContain('1070.00');
    expect(text).toContain('1000.00');
    expect(text).toContain('70.00');

    // VAT-included annotation present on the receipt too (still VAT-inclusive).
    expect(text).toMatch(/VAT included/i);

    // NO buyer Tax ID line — the buyer supplied no TIN, so the template's
    // `input.member.tax_id && (...)` conditional omits it. Prove it two ways:
    //
    //   1. Positive: the buyer legal name IS present (confirms the buyer
    //      section rendered at all, making the negative conclusive).
    //
    //   2. Negative: the bare "Tax ID: …" buyer label MUST NOT appear.
    //      The seller's TIN is rendered with a Thai prefix:
    //        "เลขประจำตัวผู้เสียภาษี / Tax ID: 0000000000000"
    //      so a multiline `^Tax ID:` (line-start anchor) is buyer-specific
    //      — the seller line never starts with "Tax ID:" because the Thai
    //      prefix sits before it on the same text node. See invoice-template.tsx
    //      line 244 (seller) vs line 276 (buyer) for the two patterns.
    expect(text, 'buyer legal name must be present in the rendered receipt').toContain(
      'Walk-in Guest',
    );
    expect(
      text,
      'buyer Tax ID block MUST NOT render when tax_id is null (§86/4 receipt path)',
    ).not.toMatch(/^Tax ID:/m);
  }, 60_000);

  it('membership-style VAT-EXCLUSIVE invoice → NO VAT-included annotation (regression guard)', async () => {
    // A membership invoice is VAT-exclusive (vatInclusive omitted/false): the
    // annotation MUST NOT appear, preserving byte-identical re-render for F4.
    const input: PdfRenderInput = {
      ...makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' }),
      vatInclusive: false,
      lines: [
        {
          lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000m1'),
          kind: 'membership_fee',
          descriptionTh: 'ค่าสมาชิก ปี 2026',
          descriptionEn: 'Membership 2026',
          unitPrice: Money.fromSatangUnsafe(100_000n),
          quantity: '1.0000',
          proRateFactor: '1.0000',
          total: Money.fromSatangUnsafe(100_000n),
          position: 1,
        },
      ],
    };
    const { bytes } = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(bytes);
    expect(text).toMatch(/Tax Invoice/i);
    expect(text, 'membership (VAT-exclusive) MUST NOT show the VAT-included note').not.toMatch(
      /VAT included/i,
    );
  }, 60_000);

  it('064 Task 12 — receipt_combined + creditedAnnotation → combined title PRESERVED + credited stamp + CN-ref footer', async () => {
    // The J2 credit-note annotation re-render of an AS-PAID parent re-renders
    // the COMBINED ใบกำกับภาษี/ใบเสร็จรับเงิน (kind='receipt_combined') with
    // the PARTIALLY CREDITED overlay + CN-reference footer. The template must
    // (a) keep the combined dual-role title — re-titling it as a plain tax
    // invoice destroys the only §105ทวิ receipt evidence — and (b) actually
    // draw the annotation on the receipt_combined kind (the overlay gate was
    // historically kind==='invoice'-only, which would silently DROP the
    // credited stamp from the overwritten blob).
    const creditedAnnotation = {
      fullyCredited: false,
      references: [
        {
          documentNumber: 'J2AC-2026-000001',
          issueDate: '2026-09-20',
          total: Money.fromSatangUnsafe(53_500n),
        },
      ],
    };

    // CONTROL — the same annotation on kind='invoice' (the long-shipped J2
    // path for bill-first parents) must extract from the bytes. This calibrates
    // the pdf-parse assertions below: if the stamp were unextractable per se,
    // the control would fail too.
    const controlInput: PdfRenderInput = {
      ...makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' }),
      creditedAnnotation,
    };
    const control = await reactPdfRenderAdapter.render(controlInput);
    const controlText = await extractPdfText(control.bytes);
    // The stamp is a rotated overlay — pdf-parse extracts its words on
    // separate lines ("PARTIALLY\nCREDITED"), so match across whitespace.
    expect(controlText, 'control: credited stamp on kind=invoice').toMatch(
      /PARTIALLY\s+CREDITED/i,
    );
    expect(controlText, 'control: CN-ref footer on kind=invoice').toContain(
      'J2AC-2026-000001',
    );

    // The receipt_combined re-render — same annotation, combined kind.
    const input: PdfRenderInput = {
      ...makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' }),
      kind: 'receipt_combined',
      creditedAnnotation,
    };
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // (a) Combined dual-role title preserved — BOTH legal labels present.
    expect(text, 'expected Thai tax-invoice label in combined title').toMatch(
      /ใบก[ำํ]​?า?กับภาษี/,
    );
    expect(text, 'expected Thai receipt label in combined title').toContain('ใบเสร็จรับเงิน');
    expect(text).toMatch(/Tax Invoice/i);
    expect(text).toMatch(/Official Receipt/i);

    // (b) Credited stamp + CN-ref footer drawn on the receipt_combined kind.
    expect(
      text,
      'PARTIALLY CREDITED stamp must render on a receipt_combined re-render',
    ).toMatch(/PARTIALLY\s+CREDITED/i);
    expect(
      text,
      'CN-reference footer must render on a receipt_combined re-render',
    ).toContain('J2AC-2026-000001');
    expect(text).toMatch(/Referenced by credit note/i);
  }, 60_000);

  it('064 Task 14 — NEGATIVE: receipt_separate + creditedAnnotation → §105 receipt title, NO credited stamp, NO CN-ref footer (M-1 no-CN-stamp rule pinned in bytes)', async () => {
    // Tax-reviewer M-1: a §105 ใบเสร็จรับเงิน must NEVER carry a credit-note
    // stamp — `receipt_separate` parents are rejected by the §86/10
    // `receipt_not_creditable` guard before any annotation render, so this
    // input shape is FABRICATED-CORRUPT (it cannot be produced by any
    // use-case). The template's `isCreditAnnotatable` allow-list is the last
    // line of defence: even fed the corrupt shape, the bytes must not show
    // the stamp or the footer. The Task 12 CONTROL above (same annotation on
    // kind='invoice' extracts fine) calibrates these negative assertions —
    // if the stamp were unextractable per se, the control would fail first.
    const input: PdfRenderInput = {
      ...makeEventRenderInput({ kind: 'receipt_separate', buyerTaxId: null }),
      creditedAnnotation: {
        fullyCredited: false,
        references: [
          {
            documentNumber: 'J2AC-2026-000001',
            issueDate: '2026-09-20',
            total: Money.fromSatangUnsafe(53_500n),
          },
        ],
      },
    };
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Title stays the plain §105 receipt — never re-titled.
    expect(text, 'expected Thai receipt title ใบเสร็จรับเงิน').toContain('ใบเสร็จรับเงิน');
    expect(text).toMatch(/Official Receipt/i);
    expect(text).not.toMatch(/Tax Invoice/i);

    // NO credited stamp — neither the partial nor the full variant.
    expect(
      text,
      '§105 receipt must NOT carry the PARTIALLY CREDITED stamp',
    ).not.toMatch(/PARTIALLY\s+CREDITED/i);
    expect(text).not.toMatch(/CREDITED/i);

    // NO "Referenced by credit note" footer and NO CN document number.
    expect(
      text,
      '§105 receipt must NOT carry the CN-reference footer',
    ).not.toMatch(/Referenced by credit note/i);
    expect(text).not.toContain('J2AC-2026-000001');
  }, 60_000);
});

// =============================================================================
// 064 Task 14 — as-paid PDF goldens through the REAL chain (live Neon).
//
// Unlike the render-input goldens above, these run the production path
// end-to-end: createEventInvoiceDraft (buyer snapshot pinned at draft) →
// issueEventInvoiceAsPaid with the REAL `reactPdfRenderAdapter` (only Vercel
// Blob is mocked — the bytes are captured from the upload call). What they
// pin, per the 064 spec:
//
//   (i)  TIN buyer → ONE combined §86/4+§105ทวิ document:
//          title "ใบกำกับภาษี / ใบเสร็จรับเงิน" + "Tax Invoice / Official
//          Receipt", document date = the BACKDATED paymentDate (CE ISO on the
//          face + Thai-side BE year — BE is DISPLAY-ONLY; storage stays CE),
//          AS-VAT-01 amounts (1,070.00 gross / 1,000.00 net / 70.00 VAT) with
//          the "VAT included" annotation, and the INVOICE-stream §87 number.
//   (ii) no-TIN buyer → §105 receipt: title "ใบเสร็จรับเงิน / Official
//          Receipt", the SEPARATE §105 register (RE) number on the face
//          (US7/T050 — NOT the §86/4 RC number, even with 'RC' configured),
//          same VAT-inclusive breakdown, NO buyer Tax ID line.
//
// Fresh tenant per describe ⇒ each register allocates deterministically: the
// TIN combined doc from the §87 invoice stream (EVG-2026-000001) and the no-TIN
// §105 from its own separate receipt_105 register (RE-2026-000001). All buyers
// are SIMULATED (fake names + fake 13-digit TINs) — never real PII.
// =============================================================================

/** Fixed clock (matches "today"); the payment is BACKDATED months earlier. */
const G14_NOW_ISO = '2026-06-10T10:00:00Z';
/** Backdated out-of-band payment date — BE display year is 2026+543 = 2569. */
const G14_PAYMENT_DATE = '2026-02-14';
/** 1,070.00 THB VAT-inclusive — the canonical 1,000 net + 70 VAT case. */
const G14_TOTAL_SATANG = 107_000;

/** SIMULATED non-member buyer WITH a fake 13-digit Thai TIN. */
const G14_BUYER_TIN = {
  legal_name: 'Simulated Golden Co Ltd',
  tax_id: '1234512345123',
  address: '123 Simulated Road, Bangkok 10110',
  primary_contact_name: 'Sim Golden',
  primary_contact_email: 'sim.golden@as-paid-golden.test',
} as const;

/** SIMULATED no-TIN walk-in buyer (tax_id null ⇒ §105 receipt). */
const G14_BUYER_NO_TIN = {
  legal_name: 'Simulated Golden Walk-in',
  tax_id: null,
  address: '99 Simulated Lane, Bangkok 10110',
  primary_contact_name: 'Sim Walkin',
  primary_contact_email: 'sim.walkin@as-paid-golden.test',
} as const;

/**
 * REAL repos/allocator/identity/audit/outbox + the REAL PDF render adapter.
 * Blob is the only mock — `uploadPdf` captures the rendered bytes so the
 * test asserts EXACTLY what production would persist to the blob store.
 */
function makeGoldenDeps(
  tenantSlug: string,
  capturedBytes: Uint8Array[],
): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: {
      uploadPdf: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
        capturedBytes.push(body);
        return { key, url: `https://blob.test/${key}` };
      }),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => G14_NOW_ISO },
    outbox: resendEmailOutboxAdapter,
    recipientLocale: recipientLocaleAdapter,
    currentTemplateVersion: 1,
    taxAtPayment: 'off',
  };
}

describe('064 Task 14 — as-paid PDF goldens via the REAL chain (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let draftTin: InvoiceId;
  let draftNoTin: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Settings — invoice prefix EVG + §86/4 receipt prefix RC; fresh tenant ⇒
    // first allocations are EVG-2026-000001 (invoice stream, TIN combined) and
    // RE-2026-000001 (separate receipt_105 register, no-TIN §105 — the 'RC'
    // prefix is deliberately NOT used by the §105 arm; US7/T050 split),
    // fully deterministic.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้าจำลอง',
        legalNameEn: 'Simulated Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'กรุงเทพมหานคร',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'EVG',
        creditNoteNumberPrefix: 'EVGC',
        receiptNumberPrefix: 'RC',
      });
    });

    // One event + two registrations (one per buyer shape) — the partial
    // unique index allows one non-void event invoice per registration.
    const eventId = randomUUID();
    const regTin = randomUUID();
    const regNoTin = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-golden-aspaid-${eventId.slice(0, 8)}`,
        name: 'Golden As-Paid Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      const baseReg = {
        tenantId: tenant.ctx.slug,
        eventId,
        attendeeName: 'Sim Attendee',
        attendeeCompany: 'Simulated Golden Co Ltd',
        matchType: 'non_member' as const,
        ticketType: 'Standard',
        ticketPriceThb: 1070,
        paymentStatus: 'paid' as const,
        registeredAt: new Date('2026-01-20T03:00:00Z'),
      };
      await tx.insert(eventRegistrations).values([
        {
          ...baseReg,
          registrationId: regTin,
          externalId: `att-golden-tin-${regTin.slice(0, 8)}`,
          attendeeEmail: G14_BUYER_TIN.primary_contact_email,
        },
        {
          ...baseReg,
          registrationId: regNoTin,
          externalId: `att-golden-notin-${regNoTin.slice(0, 8)}`,
          attendeeEmail: G14_BUYER_NO_TIN.primary_contact_email,
        },
      ] satisfies NewEventRegistrationRow[]);
    });

    // Drafts via the REAL use-case — buyer snapshots (incl. tax_id null on
    // the no-TIN shape) pin at draft exactly as production does.
    async function draft(
      registrationId: string,
      buyer: typeof G14_BUYER_TIN | typeof G14_BUYER_NO_TIN,
    ): Promise<InvoiceId> {
      const res = await createEventInvoiceDraft(
        makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          requestId: `int-golden-aspaid-draft-${registrationId}`,
          eventRegistrationId: registrationId,
          amountOverride: G14_TOTAL_SATANG,
          buyer,
        },
      );
      if (!res.ok) throw new Error(`golden draft failed: ${res.error.code}`);
      return res.value.invoiceId;
    }
    draftTin = await draft(regTin, G14_BUYER_TIN);
    draftNoTin = await draft(regNoTin, G14_BUYER_NO_TIN);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(i) TIN as-paid → combined title, document date = BACKDATED paymentDate (CE face + BE display year), AS-VAT-01 amounts + VAT-included, invoice-stream number', async () => {
    const capturedBytes: Uint8Array[] = [];
    const deps = makeGoldenDeps(tenant.ctx.slug, capturedBytes);
    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-golden-aspaid-tin-${draftTin}`,
      invoiceId: draftTin,
      paymentDate: G14_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    // The bytes asserted below are EXACTLY what went to the blob store.
    expect(capturedBytes).toHaveLength(1);
    const bytes = capturedBytes[0]!;
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Combined dual-role title — BOTH legal labels, TH + EN. Thai
    // "ใบกำกับภาษี" may extract with sara-am decomposed (ํา) per shapeThai.
    expect(text, 'expected Thai tax-invoice label').toMatch(/ใบก[ำํ]​?า?กับภาษี/);
    expect(text, 'expected Thai receipt label').toContain('ใบเสร็จรับเงิน');
    expect(text).toMatch(/Tax Invoice/i);
    expect(text).toMatch(/Official Receipt/i);

    // Document date = the BACKDATED paymentDate. The face carries the CE
    // ISO date; the Thai side renders the BE year alongside (พ.ศ. 2569 =
    // 2026 + 543) — BE is DISPLAY-ONLY, never stored. shapeThai may inject
    // ZWSP (U+200B) inside "พ.ศ.", so the regex tolerates it between every
    // glyph. The as-paid pin also makes due = issue = payment.
    expect(text, 'document date must be the backdated paymentDate (CE)').toContain(
      `Date: ${G14_PAYMENT_DATE}`,
    );
    expect(text, 'Thai side must show the BE year of the paymentDate').toMatch(
      /พ​?\.​?ศ​?\.​?[\s​]*2569/,
    );
    expect(text, 'as-paid: due = issue = payment').toContain(`Due: ${G14_PAYMENT_DATE}`);

    // AS-VAT-01 amounts — inclusive 1,070.00 line/total, 1,000.00 net,
    // 70.00 VAT, with the bilingual VAT-included annotation.
    expect(text).toContain('1070.00');
    expect(text).toContain('1000.00');
    expect(text).toContain('70.00');
    expect(text, 'expected the VAT-included annotation').toMatch(/VAT included/i);

    // Invoice-stream §87 number on the face (fresh tenant ⇒ deterministic).
    expect(res.value.documentNumber?.raw).toBe('EVG-2026-000001');
    expect(text, 'invoice-stream document number on the face').toContain(
      'EVG-2026-000001',
    );

    // §86/4 — the combined document carries the buyer's Tax ID.
    expect(text).toContain(G14_BUYER_TIN.tax_id);
    // T15 positive control for golden (ii)'s `^Tax ID:` NEGATIVE: the buyer
    // Tax-ID line really does render at line start in this exact shape, so
    // the (ii) `not.toMatch(/^Tax ID:/m)` proof cannot rot silently.
    expect(text).toMatch(/^Tax ID: 1234512345123/m);
  }, 120_000);

  it('(ii) no-TIN as-paid → §105 receipt title, separate receipt_105 (RE) number on the face, same VAT-inclusive breakdown, NO buyer Tax ID line', async () => {
    const capturedBytes: Uint8Array[] = [];
    const deps = makeGoldenDeps(tenant.ctx.slug, capturedBytes);
    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-golden-aspaid-notin-${draftNoTin}`,
      invoiceId: draftNoTin,
      paymentDate: G14_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    expect(capturedBytes).toHaveLength(1);
    const bytes = capturedBytes[0]!;
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // §105 receipt title ONLY — a TIN-less buyer can never get a §86/4
    // ใบกำกับภาษี (and therefore not the combined title either).
    expect(text, 'expected Thai receipt title ใบเสร็จรับเงิน').toContain('ใบเสร็จรับเงิน');
    expect(text).toMatch(/Official Receipt/i);
    expect(text).not.toMatch(/Tax Invoice/i);

    // Separate §105 register (RE) number on the face (US7/T050 — neither the
    // §87 invoice stream nor the §86/4 RC receipt stream is burned for a §105
    // receipt; the 'RC' prefix configured above is deliberately not used here).
    expect(res.value.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(res.value.documentNumber).toBeNull();
    expect(text, 'separate §105 (RE) number on the face').toContain('RE-2026-000001');

    // Document date = backdated paymentDate (CE face + BE display year).
    expect(text).toContain(`Date: ${G14_PAYMENT_DATE}`);
    expect(text).toMatch(/พ​?\.​?ศ​?\.​?[\s​]*2569/);

    // Same VAT-inclusive breakdown as the combined document.
    expect(text).toContain('1070.00');
    expect(text).toContain('1000.00');
    expect(text).toContain('70.00');
    expect(text).toMatch(/VAT included/i);

    // NO buyer Tax ID line — same two-sided proof as golden (ii) above:
    // buyer name present (block rendered) + no line-start "Tax ID:".
    expect(text).toContain(G14_BUYER_NO_TIN.legal_name);
    expect(text).not.toMatch(/^Tax ID:/m);
  }, 120_000);
});

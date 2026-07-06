/**
 * T044 — Bilingual Thai-tax invoice PDF template v1 (F4).
 *
 * Thai RD § 86/4 required fields:
 *   - "ใบกำกับภาษี / Tax Invoice" label
 *   - Seller legal name + tax id + address
 *   - Buyer legal name + tax id + address
 *   - Invoice date (issue_date in CE; BE shown alongside in TH section)
 *   - Sequential document number
 *   - Itemised lines (description, quantity, unit price, line total)
 *   - Subtotal, VAT rate + amount, grand total
 *   - Amount in words (TH + EN)
 *
 * Deterministic rendering: no Date.now(), no Math.random(), no remote
 * resources. Font registration pinned via registerSarabun().
 */
import { Document, Image, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { PdfRenderInput } from '../../../application/ports/pdf-render-port';
import { amountToThaiWords } from '../amount-to-thai';
import { amountToEnglishWords } from '../amount-to-english';
import { shapeThai } from '../fonts/register-sarabun';
import {
  KIND_AWARE_CITATION_MIN_VERSION,
  LEGACY_FOOTER_CITATION,
  revenueCodeCitation,
} from './revenue-code-citation';
import { buyerHasTin } from '../../../domain/document-kind';
// 088 US4 (T034/T035 / FR-009) — pure, locale-independent formatting helpers.
// Extracted to `../format-thb` so the unit test imports them WITHOUT pulling in
// @react-pdf/renderer. `formatThbSatang(satang, grouped)` groups the integer
// part with ',' thousands separators when `grouped` (v6+); default false keeps
// the pre-v6 ungrouped output byte-identical (SC-003).
import { capitalizeFirstLetter, formatThbSatang } from '../format-thb';

const styles = StyleSheet.create({
  page: { fontFamily: 'Sarabun', fontSize: 10, padding: 36, color: '#111' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    gap: 12,
  },
  // Left column (tenant identity): flex-shrink enabled so a long
  // address wraps instead of pushing into the right column.
  headerLeft: { flex: 1, minWidth: 0 },
  // Tenant logo — bounded so a tall logo cannot push the header text
  // off the page. `objectFit: 'contain'` preserves aspect ratio inside
  // the box. Dimensions roughly match the upload bounds (200-2000 ×
  // 100-500 px) re-scaled into the PDF coordinate space.
  logo: { maxWidth: 160, maxHeight: 60, marginBottom: 6, objectFit: 'contain' },
  // Right column (title + doc number + dates): stays intrinsic-sized,
  // never shrinks below content, never overlaps left column.
  headerRight: { alignItems: 'flex-end', flexShrink: 0, maxWidth: '40%' },
  // `maxWidth: '100%'` on each Text style forces the leaf <Text>
  // element to respect the parent container's content width. Without
  // this, fontkit's Thai shaping tricks @react-pdf into thinking the
  // text fits on one line (advance-width under-counts after sara-am
  // decomposition), and long Thai strings overflow the section
  // container horizontally instead of wrapping.
  h1: { fontSize: 16, fontWeight: 700, marginBottom: 2, maxWidth: '100%' },
  h2: { fontSize: 12, fontWeight: 500, marginBottom: 2, maxWidth: '100%' },
  label: { fontSize: 9, color: '#555', maxWidth: '100%' },
  // `maxLines: 3` + ellipsis safeguards against pathologically long
  // Thai strings (e.g., 130+ char legal names) that @react-pdf +
  // fontkit cannot wrap reliably. Three lines gives room for even a
  // long normal company name to render in full.
  value: { fontSize: 10, maxWidth: '100%', maxLines: 3, textOverflow: 'ellipsis' },
  // Buyer-address lines (code-review M-01): a tax invoice must show the buyer's
  // COMPLETE address (§86/4), so these get a higher per-line cap than `value`'s
  // 3 — a real Thai address component (street / locality) fits well within 5,
  // while the ellipsis still guards against a pathologically long single field
  // that @react-pdf/fontkit cannot wrap.
  addrLine: { fontSize: 10, maxWidth: '100%', maxLines: 5, textOverflow: 'ellipsis' },
  // 088 US4 (T035a / FR-034) — the §86/4 buyer NAME + ADDRESS must NEVER be
  // silently truncated: a clipped buyer name / dropped address line is
  // non-compliant. From v6 the buyer name + address use this UNCLAMPED style
  // (no `maxLines` / `textOverflow`) so long content wraps and paginates
  // (react-pdf `<Page wrap>` is on by default) instead of ellipsising. Pre-v6
  // renders keep `value` / `addrLine` (the 3 / 5-line clips) byte-stable.
  valueUnclamped: { fontSize: 10, maxWidth: '100%' },
  section: { marginBottom: 12, width: '100%' },
  table: { marginTop: 8, marginBottom: 8, borderTop: '1 solid #ccc' },
  tr: { flexDirection: 'row', borderBottom: '1 solid #eee', paddingVertical: 4 },
  trHead: {
    flexDirection: 'row',
    backgroundColor: '#f5f5f5',
    paddingVertical: 4,
    fontWeight: 500,
  },
  tdDesc: { flex: 3, paddingHorizontal: 4 },
  tdQty: { flex: 1, textAlign: 'right', paddingHorizontal: 4 },
  tdUnit: { flex: 1, textAlign: 'right', paddingHorizontal: 4 },
  tdTotal: { flex: 1, textAlign: 'right', paddingHorizontal: 4 },
  totalsBlock: { marginTop: 12, alignItems: 'flex-end' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', width: 240, paddingVertical: 2 },
  totalLabel: { fontWeight: 500 },
  totalValue: { fontWeight: 500 },
  grand: { fontSize: 12, fontWeight: 700, marginTop: 4 },
  wordsLine: { marginTop: 8, fontSize: 9, color: '#333' },
  // 054-event-fee-invoices — VAT-inclusive annotation under the totals block.
  // Right-aligned so it sits beneath the grand-total figure; muted colour so it
  // reads as a clarifying note, not a new line item.
  vatInclusiveNote: { marginTop: 4, fontSize: 8, color: '#555', textAlign: 'right' },
  watermark: {
    // FR-001a / US1-AS5 — the mandated draft watermark is a long bilingual
    // string ("DRAFT / ร่าง — NOT A TAX DOCUMENT"), so the font is sized down
    // + repositioned from the old single-word "PREVIEW" so it fits on one
    // diagonal line across A4. Visual fit to be confirmed on the preview deploy.
    position: 'absolute',
    top: 360,
    left: 40,
    fontSize: 28,
    color: '#eee',
    transform: 'rotate(-30deg)',
    fontWeight: 700,
  },
  // FR-008 — diagonal VOID overlay, bilingual (TH+EN), on EVERY page,
  // 45° rotation. `position: absolute` + the `fixed` prop on the Text element
  // makes the stamp repeat on every page without interleaving with flow content.
  //
  // 094 (status-watermark-opacity) — this is the PRE-v10 (legacy) prominent
  // variant at 50% opacity. It over-printed the opaque grey table-header row +
  // line-item text on a voided tax document (prod UAT defect), so v10+ renders
  // `voidStampFaint` instead. Retained UNCHANGED so a pinned pre-v10 void
  // re-render (resend / void-overlay at its stored `pdf_template_version`)
  // reproduces its ORIGINAL bytes (SC-003). Gate: STATUS_STAMP_FAINT_MIN_VERSION.
  voidStamp: {
    position: 'absolute',
    top: 300,
    left: 90,
    fontSize: 80,
    color: 'rgba(200,0,0,0.5)',
    fontWeight: 700,
    transform: 'rotate(-45deg)',
  },
  // 094 — v10+ FAINT VOID stamp. Geometry (position / size / angle) is IDENTICAL
  // to `voidStamp`; ONLY the opacity drops to ~10% so the large diagonal stamp
  // sits BEHIND the document content instead of clashing with it. Hue preserved.
  voidStampFaint: {
    position: 'absolute',
    top: 300,
    left: 90,
    fontSize: 80,
    color: 'rgba(200,0,0,0.10)',
    fontWeight: 700,
    transform: 'rotate(-45deg)',
  },
  footer: { marginTop: 24, fontSize: 8, color: '#777', textAlign: 'center' },
  // 088 US5 (T041 / FR-012) — tenant WHT footer note. Muted, left-aligned block
  // sitting below the amount-in-words lines. Bilingual (TH shaped + EN gloss),
  // each line guarded independently so a tenant configuring only one language
  // renders only that line. `maxWidth:'100%'` for the Thai wrap safeguard.
  whtNoteBlock: { marginTop: 16, width: '100%' },
  whtNoteLine: { fontSize: 8, color: '#555', maxWidth: '100%', marginBottom: 2 },
  // 088 US8 (T058 / FR-025) — §80/1(5) zero-rate note block on the §86/4 tax
  // receipt. Framed with a left accent border (matches the bank/credit-note
  // reference-block pattern) so it reads as the tax-basis callout. Muted body.
  zeroRateNoteBlock: {
    marginTop: 16,
    padding: 8,
    borderLeft: '3 solid #444',
    backgroundColor: '#fafafa',
    width: '100%',
  },
  zeroRateNoteLine: { fontSize: 9, color: '#333', maxWidth: '100%', marginBottom: 2 },
  // 088 US5 (T042 / FR-022) — offline-payment bank block on the ใบแจ้งหนี้ ONLY.
  // Framed with a left accent border (matches the credit-note reference block
  // pattern) so it reads as the payment-instruction box.
  bankBlock: {
    marginTop: 16,
    padding: 8,
    borderLeft: '3 solid #444',
    backgroundColor: '#fafafa',
    width: '100%',
  },
  bankLabel: { fontSize: 9, color: '#555', marginBottom: 4, fontWeight: 500, maxWidth: '100%' },
  bankLine: { fontSize: 9, color: '#333', marginBottom: 2, maxWidth: '100%' },
  bankInstructions: { fontSize: 8, color: '#555', marginTop: 4, maxWidth: '100%' },
  // 088 US5 (T042 / FR-022) — layout-only signature stamps on the ใบแจ้งหนี้.
  // Three equal cells (Issued by / Received by / Date) with a top rule so the
  // reader sees blank sign-off lines. Per the task these are BLANK layout fields
  // (NOT auto-filled with a preparer name — see the FR-022 deviation note).
  signatureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 12,
  },
  signatureCell: { flex: 1, borderTop: '1 solid #999', paddingTop: 4, alignItems: 'center' },
  signatureLabel: { fontSize: 8, color: '#555', maxWidth: '100%' },
  // T079 — credit-note reference block. Rendered between the customer
  // section and the line-items table so the reader's eye scans the
  // legal continuity (this document references invoice #X) before the
  // monetary amounts. Framed with a left accent border to set it
  // visually apart from regular metadata without adding colour.
  cnRefBlock: {
    marginBottom: 12,
    padding: 8,
    borderLeft: '3 solid #444',
    backgroundColor: '#fafafa',
  },
  cnRefLine: { fontSize: 10, marginBottom: 2 },
  cnRefLabel: { fontSize: 9, color: '#555', marginBottom: 2 },
  // US6 AS4 — credited-invoice diagonal overlay. Colour matches the
  // VOID stamp pattern (warm amber) so the visual vocabulary is consistent:
  // "this document carries a status-change annotation".
  //
  // 094 (status-watermark-opacity) — this is the PRE-v10 (legacy) prominent
  // variant at 32% opacity, retained UNCHANGED so a pinned pre-v10 credited
  // annotation re-render reproduces its ORIGINAL bytes (SC-003). v10+ renders
  // `creditedStampFaint` instead. Gate: STATUS_STAMP_FAINT_MIN_VERSION.
  creditedStamp: {
    position: 'absolute',
    top: 260,
    left: 100,
    fontSize: 64,
    color: 'rgba(180,80,0,0.32)',
    fontWeight: 700,
    transform: 'rotate(-20deg)',
  },
  // 094 — v10+ FAINT credited stamp. Geometry (position / size / angle)
  // IDENTICAL to `creditedStamp`; ONLY the opacity drops to ~10% so the large
  // diagonal stamp sits BEHIND the document content. Hue preserved.
  creditedStampFaint: {
    position: 'absolute',
    top: 260,
    left: 100,
    fontSize: 64,
    color: 'rgba(180,80,0,0.10)',
    fontWeight: 700,
    transform: 'rotate(-20deg)',
  },
  // Footer table listing referencing credit notes. Rendered below the
  // amount-in-words lines, above the document footer.
  cnRefFooterBlock: {
    marginTop: 12,
    padding: 8,
    borderTop: '1 solid #ccc',
  },
  cnRefFooterLabel: {
    fontSize: 9,
    color: '#555',
    marginBottom: 4,
    fontWeight: 500,
  },
  cnRefFooterRow: {
    flexDirection: 'row',
    fontSize: 9,
    marginBottom: 2,
  },
  cnRefFooterCell: { flex: 1 },
  cnRefFooterCellAmt: { flex: 1, textAlign: 'right' },
});

/**
 * Buddhist Era year helper — CE + 543.
 */
function beYear(isoDate: string | null): string {
  if (!isoDate) return '';
  const year = Number(isoDate.slice(0, 4));
  return (year + 543).toString();
}

/**
 * 088 US2 (T025 / FR-004 / SC-004 / §105ทวิ) — first template version whose
 * `receipt_combined` (ใบกำกับภาษี/ใบเสร็จรับเงิน) renders as ต้นฉบับ (Original)
 * + สำเนา (Copy) = two pages in ONE PDF. Gated so a pinned pre-v4 combined
 * receipt (resend / Blob-miss recovery / void-overlay / any historical
 * re-render at its stored `pdf_template_version`) still paginates to a SINGLE
 * page — preserving the SC-003 reproduce-the-original guarantee for
 * already-issued documents, exactly like the v3 kind-aware-citation gate.
 * Registry log: template-registry.ts v4 entry.
 */
const TWO_PAGE_RECEIPT_COPY_MIN_VERSION = 4;

/**
 * 088 US3 (T032 / FR-008 / SC-004) — first template version whose §86/4 blocks
 * render the Head-Office / Branch line (both parties). Gated so a pinned pre-v5
 * document (resend / void-overlay / async worker / any re-render at its stored
 * `pdf_template_version`) reproduces its ORIGINAL bytes with NO branch line —
 * preserving the SC-003 reproduce-the-original guarantee, exactly like the v3
 * kind-aware-citation + v4 two-page gates. Registry log: template-registry.ts v5.
 */
const HEAD_OFFICE_BRANCH_MIN_VERSION = 5;

/**
 * 088 US4 (T035 / T035a / FR-009 / FR-010 / FR-034) — first template version
 * whose §86/4 body gets the presentation polish: (a) thousands-separated
 * amounts + capitalized English amount-in-words; (b) buyer block reordered to
 * Name → Address → Tax ID → Head-Office/Branch; (c) buyer name + address no
 * longer clip at 3 / 5 lines (they wrap / paginate). ALL THREE gate on this so
 * a pinned pre-v6 document re-renders byte-stable (ungrouped amounts, lowercase
 * words, legacy order, 3/5-line clips) — the SC-003 reproduce-the-original
 * guarantee, exactly like the v3 citation + v4 two-page + v5 branch-line gates.
 * Registry log: template-registry.ts v6.
 */
const PRESENTATION_POLISH_MIN_VERSION = 6;

/**
 * 088 US5 (T041 / T042 / FR-012 / FR-022 / SC-007) — first template version that
 * (a) DROPS the hardcoded "Rendered by Chamber-OS (§-citation)" footer and
 * renders the tenant WHT note on membership documents instead, and (b) renders
 * the offline-payment bank block + signature stamps on the ใบแจ้งหนี้ (bill).
 * Gated so a pinned pre-v7 document re-renders byte-stable (NO WHT note, NO bank
 * block, KEEPS the legacy footer) — the SC-003 reproduce-the-original guarantee,
 * exactly like the v3 citation + v4 two-page + v5 branch-line + v6 polish gates.
 * Registry log: template-registry.ts v7.
 */
const WHT_AND_BANK_BLOCK_MIN_VERSION = 7;

/**
 * 088 US8 (T058 / FR-025 / SC-008) — first template version that renders the
 * §80/1(5) embassy / int'l-org VAT-zero-rate note on the §86/4 tax invoice /
 * receipt. Gated so a pinned pre-v8 document (resend / void-overlay / async
 * worker / any re-render at its stored `pdf_template_version`) reproduces its
 * ORIGINAL bytes with NO §80/1(5) note — the SC-003 reproduce-the-original
 * guarantee, exactly like the v3 citation + v4 two-page + v5 branch-line + v6
 * polish + v7 WHT/bank gates. Registry log: template-registry.ts v8.
 */
const ZERO_RATE_NOTE_MIN_VERSION = 8;

/**
 * 093 (WHT-note premature-wrap fix) — per-call-site Thai wrap budget for the
 * full-width WHT-note block.
 *
 * The global `shapeThai` default (55 chars/line) is calibrated for the NARROWEST
 * Thai container (the ~half-width seller header block). The WHT note renders in
 * `whtNoteBlock` (width 100%, `whtNoteLine` fontSize 8) whose content width is
 * 523.28pt (A4 595.28 − 2×36 page padding). At fontSize 8 the ~68-char TSCC
 * accountant note renders at only 224.79pt (43% of the block — measured with
 * fontkit 2.0.4 / Sarabun-Regular, the engine @react-pdf/renderer lays glyphs
 * with), yet the 55 budget force-wraps it onto TWO lines even though the LONGER
 * 85-char English gloss (298.30pt) fits on one.
 *
 * 72 keeps the real 68-char note on ONE line with headroom while still wrapping a
 * genuinely-too-long (73+ char) note. It sits safely below the measured
 * worst-case single-line capacity of 78 chars (widest Thai consonant ฒ = 6.648pt
 * @8pt → 523.28 / 6.648 ≈ 78), so every wrapped line (≤72 chars, ≤478.7pt
 * worst-case) stays clear of the 523.28pt edge — no overflow / silent clip.
 */
export const WHT_NOTE_WRAP_THRESHOLD_CHARS = 72;

/**
 * 093 — first template version that renders the WHT note at the wider
 * `WHT_NOTE_WRAP_THRESHOLD_CHARS` budget. Gated so a pinned pre-v9 document
 * (resend / void-overlay / async worker / any re-render at its stored
 * `pdf_template_version`) reproduces its ORIGINAL bytes — the note wraps at the
 * legacy 55 budget — preserving the SC-003 reproduce-the-original guarantee,
 * exactly like the v3 citation + v4 two-page + v5 branch-line + v6 polish + v7
 * WHT/bank + v8 zero-rate gates. Registry log: template-registry.ts v9.
 */
const WHT_NOTE_WRAP_FIX_MIN_VERSION = 9;

/**
 * 094 (status-watermark-opacity) — first template version that renders the
 * diagonal VOID / CREDITED status stamp as a LARGE FAINT (~10% opacity)
 * behind-content watermark instead of the pre-v10 prominent 32-50% opacity that
 * over-printed the opaque table-header row + line-item text on a credited /
 * voided tax document (prod UAT defect). ONLY the stamp COLOUR/opacity changes
 * (hue, size, angle, position preserved); the DRAFT preview watermark (#eee,
 * already faint) is untouched.
 *
 * Gated so a pinned pre-v10 document (resend / void-overlay / credited-annotation
 * re-render at its stored `pdf_template_version`) reproduces its ORIGINAL
 * prominent stamp — the SC-003 reproduce-the-original guarantee, exactly like
 * the v3–v9 gates. Both re-render paths thread the blob's PINNED version
 * (void-invoice.ts / issue-credit-note.ts), so already-issued ≤v9 documents keep
 * the prominent stamp; only v10+ issuances get the faint stamp. Because the two
 * stamp styles only apply to a rendered VOID / CREDITED overlay, every document
 * WITHOUT a status stamp renders byte-identical at v10 as at v9. Registry log:
 * template-registry.ts v10.
 */
export const STATUS_STAMP_FAINT_MIN_VERSION = 10;

/**
 * 088 US8 — the §80/1(5) zero-rate note lines (bilingual, hardcoded literal per
 * the template's shaped-Thai + English-gloss convention — the PDF carries no
 * i18n context). Line 1 cites the Revenue-Code basis; line 2 references the MFA
 * (Protocol Dept) certificate number + date. The scan is NOT appended (G6).
 */
function section8015NoteLines(
  certNo: string | null,
  certDate: string | null,
): { citation: string; certRef: string } {
  return {
    citation:
      shapeThai('ภาษีมูลค่าเพิ่มอัตรา 0% ตามมาตรา 80/1(5) แห่งประมวลรัษฎากร') +
      ' / VAT 0% under Revenue Code 80/1(5)',
    certRef:
      shapeThai('หนังสือรับรองกระทรวงการต่างประเทศเลขที่') +
      ' / MFA certificate no.: ' +
      (certNo ?? '-') +
      (certDate ? ` (${certDate})` : ''),
  };
}

/**
 * 088 US3 — the §86/4 สำนักงานใหญ่ / Head Office | สาขาที่ NNNNN / Branch line.
 * A head office renders "สำนักงานใหญ่ / Head Office"; a branch renders
 * "สาขาที่ <code> / Branch". The bilingual literals match the existing template
 * pattern (hardcoded shaped-Thai + English gloss — no i18n key on the PDF).
 */
function headOfficeBranchLine(
  isHeadOffice: boolean,
  branchCode: string | null,
): string {
  return isHeadOffice
    ? shapeThai('สำนักงานใหญ่') + ' / Head Office'
    : shapeThai('สาขาที่ ' + (branchCode ?? '')) + ' / Branch';
}

interface PageBodyProps {
  readonly input: PdfRenderInput;
  readonly isPreview: boolean;
  readonly isVoid: boolean;
  readonly isBill: boolean;
  readonly isCreditAnnotatable: boolean;
  readonly titleTh: string;
  readonly titleEn: string;
  readonly footerCitation: string;
  readonly totalThb: number;
  /**
   * The §86/4 original/copy marker for THIS page: `'ต้นฉบับ / ORIGINAL'` on the
   * original, `'สำเนา / COPY'` on the §105ทวิ copy of a two-page combined tax
   * receipt, or `null` (preview / void / bill — those carry their own
   * watermark). Every OTHER element of the body is identical between the two
   * pages, so the copy is a true คู่ฉบับ.
   */
  readonly copyMarker: string | null;
  /**
   * 088 US4 (FR-009 / FR-010 / FR-034) — true when `templateVersion >=
   * PRESENTATION_POLISH_MIN_VERSION` (=6): apply thousands separators +
   * capitalized English words, the reordered buyer block, and the unclamped
   * (non-clipping) buyer name / address. False (pre-v6) keeps the legacy
   * output byte-stable. Computed ONCE in `InvoiceTemplate` and threaded here so
   * BOTH pages of the two-page combined receipt render consistently.
   */
  readonly polish: boolean;
  /**
   * 094 (status-watermark-opacity) — true when `templateVersion >=
   * STATUS_STAMP_FAINT_MIN_VERSION` (=10): the VOID / CREDITED diagonal status
   * stamp renders at the faint ~10% opacity (behind-content watermark) instead
   * of the pre-v10 prominent 32-50%. False (pre-v10) keeps the original bytes
   * (SC-003). Computed ONCE in `InvoiceTemplate` and threaded here so BOTH pages
   * of a two-page combined receipt's VOID re-render stamp consistently.
   */
  readonly faintStatusStamp: boolean;
}

/**
 * The single-page document body. Extracted verbatim from the historical inline
 * `<Page>` children so the two-page `receipt_combined` render (Original + Copy)
 * can reuse the SAME body with only `copyMarker` differing. Invoked as a plain
 * function (not `<PageBody/>`) so the returned element tree is spliced directly
 * under each `<Page>` — every non-combined kind renders exactly one instance,
 * byte-for-length identical to the pre-088 inline body (verified against the
 * deterministic render length + extracted text for all six kinds).
 */
function renderPageBody({
  input,
  isPreview,
  isVoid,
  isBill,
  isCreditAnnotatable,
  titleTh,
  titleEn,
  footerCitation,
  totalThb,
  copyMarker,
  polish,
  faintStatusStamp,
}: PageBodyProps) {
  // 088 US4 (T035 / FR-010 / FR-034) — the §86/4 buyer particulars, extracted
  // so the block can render in the polished order (v6) OR the legacy order
  // (pre-v6) byte-stably, and so the buyer name + address can swap to the
  // UNCLAMPED (non-clipping) style at v6 (FR-034: never silently truncated).
  const buyerNameEl = (
    <Text style={polish ? styles.valueUnclamped : styles.value}>
      {shapeThai(input.member.legal_name)}
    </Text>
  );
  // 066-membership-no-tin — render the buyer Tax ID line ONLY when a non-blank
  // TIN is present, via the SHARED `buyerHasTin` discriminator (the same one the
  // issue/pay/credit gates use). Byte-identical for a real TIN (renders) and
  // null (omitted) — only whitespace changes.
  const buyerTaxIdEl = buyerHasTin(input.member.tax_id) ? (
    <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
  ) : null;
  // 055-member-number — the buyer's FORMATTED member number (`SCCM-0042`),
  // pinned on the snapshot at ISSUE time. Guarded `!== null` (NOT truthy) so a
  // historical snapshot (zod `.default(null)`) omits the line, preserving
  // SC-003 byte-stable re-render of already-issued documents.
  const buyerMemberNoEl =
    input.member.member_number_display !== null ? (
      <Text style={styles.label}>
        {shapeThai('หมายเลขสมาชิก')} / Member No.: {input.member.member_number_display}
      </Text>
    ) : null;
  const buyerAddrEls = input.member.address.split('\n').map((line, i) => (
    <Text
      key={`buyer-addr-${i}`}
      style={polish ? styles.valueUnclamped : styles.addrLine}
    >
      {shapeThai(line)}
    </Text>
  ));
  // 088 US3 (T032 / FR-008 / AS1-3) — the BUYER §86/4 Head-Office / Branch line.
  // Drawn ONLY for a VAT-registrant juristic buyer (`buyer_is_vat_registrant`,
  // populated at issue from `legal_entity_type ≠ 'individual'` AND non-NULL —
  // NEVER `buyerHasTin`): AS1 registrant + no branch → สำนักงานใหญ่ (default);
  // AS2 branch code → สาขาที่ NNNNN; AS3 individual / NULL type → NO line
  // (fail-closed). Gated on templateVersion so pre-v5 documents re-render
  // byte-stable (SC-003). Its own gate (v>=5) is ⊆ the v6 polish gate, so the
  // v6 reorder never resurrects it on a pre-v5 pin.
  const buyerBranchEl =
    input.member.buyer_is_vat_registrant === true &&
    input.templateVersion >= HEAD_OFFICE_BRANCH_MIN_VERSION ? (
      <Text style={styles.label}>
        {headOfficeBranchLine(
          input.member.buyer_is_head_office ?? true,
          input.member.buyer_branch_code ?? null,
        )}
      </Text>
    ) : null;
  const buyerContactEl = input.member.primary_contact_name ? (
    <Text style={styles.label}>
      {shapeThai('ผู้ติดต่อ')} / Contact: {shapeThai(input.member.primary_contact_name)}
    </Text>
  ) : null;

  return (
    <>
      {isPreview && (
        <Text style={styles.watermark}>
          DRAFT / {shapeThai('ร่าง')} — NOT A TAX DOCUMENT
        </Text>
      )}
      {isVoid && (
        <Text fixed style={faintStatusStamp ? styles.voidStampFaint : styles.voidStamp}>
          VOID / {shapeThai('ยกเลิก')}
        </Text>
      )}
      {isCreditAnnotatable && input.creditedAnnotation && (
        <Text style={faintStatusStamp ? styles.creditedStampFaint : styles.creditedStamp}>
          {input.creditedAnnotation.fullyCredited
            ? shapeThai('ลดหนี้แล้ว') + ' / CREDITED'
            : shapeThai('ลดหนี้บางส่วน') + ' / PARTIALLY CREDITED'}
        </Text>
      )}

      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          {input.tenantLogo && (
            // @react-pdf/renderer v4 TYPES require `Buffer` for
            // `Image.src.data` (the RUNTIME accepts Uint8Array fine
            // but the .d.ts is narrower than the implementation).
            // `Buffer.from(uint8array)` is zero-copy in Node — it
            // creates a Buffer VIEW over the same underlying memory
            // rather than allocating, so the overhead is just an
            // object wrapper. Future-Edge port: replace with `bytes`
            // directly once react-pdf widens its src typing.
            //
            // a11y note: no `alt` prop — react-pdf renders to PDF
            // coordinate space (no DOM / no SR tree) and the
            // `ImageProps` type does not accept one. The legal
            // name is rendered alongside in `styles.identityName`
            // so a decorative annotation would be moot regardless.
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image
              src={{
                data: Buffer.from(input.tenantLogo.bytes),
                format: input.tenantLogo.format,
              }}
              style={styles.logo}
            />
          )}
          <Text style={styles.h1}>{shapeThai(input.tenant.legal_name_th)}</Text>
          <Text style={styles.h2}>{input.tenant.legal_name_en}</Text>
          <Text style={styles.value}>{shapeThai(input.tenant.address_th)}</Text>
          <Text style={styles.value}>{input.tenant.address_en}</Text>
          <Text style={styles.label}>
            {shapeThai('เลขประจำตัวผู้เสียภาษี')} / Tax ID: {input.tenant.tax_id}
          </Text>
          {/* 088 US3 (T032 / FR-008 / AS4) — the SELLER §86/4 Head-Office /
              Branch line. TSCC is always สำนักงานใหญ่ / Head Office; the branch
              fallback stays dormant until US5 wires the tenant seller-branch
              columns (`seller_is_head_office ?? true`). Gated on templateVersion
              so pre-v5 documents re-render byte-stable (SC-003). */}
          {input.templateVersion >= HEAD_OFFICE_BRANCH_MIN_VERSION && (
            <Text style={styles.label}>
              {headOfficeBranchLine(
                input.tenant.seller_is_head_office ?? true,
                input.tenant.seller_branch_code ?? null,
              )}
            </Text>
          )}
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.h1}>{shapeThai(titleTh)}</Text>
          <Text style={styles.h2}>{titleEn}</Text>
          {copyMarker && (
            <Text style={[styles.label, { fontWeight: 700 }]}>
              {shapeThai(copyMarker)}
            </Text>
          )}
          {input.documentNumber && (
            <Text style={styles.value}>No. {input.documentNumber.raw}</Text>
          )}
          {input.issueDate && (
            <Text style={styles.label}>
              {shapeThai('วันที่')} / Date: {input.issueDate} ({shapeThai('พ.ศ.')}{' '}
              {beYear(input.issueDate)})
            </Text>
          )}
          {input.dueDate && (
            <Text style={styles.label}>
              {shapeThai('ครบกำหนด')} / Due: {input.dueDate}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>{shapeThai('ลูกค้า')} / Customer</Text>
        {polish ? (
          // 088 US4 (T035 / FR-010) — v6 order: Name → Address → Tax ID →
          // Head-Office/Branch → member number → contact. The branch line's own
          // gate (v>=5) still applies inside `buyerBranchEl`.
          <>
            {buyerNameEl}
            {buyerAddrEls}
            {buyerTaxIdEl}
            {buyerBranchEl}
            {buyerMemberNoEl}
            {buyerContactEl}
          </>
        ) : (
          // pre-v6 legacy order — BYTE-STABLE (SC-003): Name → Tax ID → member
          // number → Address → Head-Office/Branch → contact. Same elements as
          // the historical inline block; only wrapped in a byte-transparent
          // Fragment.
          <>
            {buyerNameEl}
            {buyerTaxIdEl}
            {buyerMemberNoEl}
            {buyerAddrEls}
            {buyerBranchEl}
            {buyerContactEl}
          </>
        )}
      </View>

      {input.kind === 'credit_note' && input.creditNote && (
        <View style={styles.cnRefBlock}>
          <Text style={styles.cnRefLabel}>
            {shapeThai('อ้างอิงใบกำกับภาษีต้นฉบับ')} / Reference to Original Tax Invoice
          </Text>
          <Text style={styles.cnRefLine}>
            {shapeThai('เลขที่')} / No.: {input.creditNote.originalDocumentNumber}
          </Text>
          <Text style={styles.cnRefLine}>
            {shapeThai('วันที่')} / Date: {input.creditNote.originalIssueDate}
            {' ('}{shapeThai('พ.ศ.')} {beYear(input.creditNote.originalIssueDate)}
            {')'}
          </Text>
          <Text style={styles.cnRefLine}>
            {shapeThai('เหตุผล')} / Reason: {shapeThai(input.creditNote.reason)}
          </Text>
        </View>
      )}

      <View style={styles.table}>
        <View style={styles.trHead}>
          <Text style={styles.tdDesc}>{shapeThai('รายการ')} / Description</Text>
          <Text style={styles.tdQty}>{shapeThai('จำนวน')} / Qty</Text>
          <Text style={styles.tdUnit}>{shapeThai('ราคา')} / Unit</Text>
          <Text style={styles.tdTotal}>{shapeThai('รวม')} / Total</Text>
        </View>
        {input.lines.map((l) => (
          <View key={l.lineId} style={styles.tr}>
            <View style={styles.tdDesc}>
              {/* 088 US4 (FR-034) — the Thai description needs the maxWidth:'100%'
                  wrap safeguard (every other multilingual Text has it); without it
                  fontkit's advance-width under-count overflows the narrow tdDesc cell
                  instead of wrapping. Only the v6 FR-011 line is long enough to
                  overflow, so it is gated on `polish` to keep pre-v6 bytes stable. */}
              <Text {...(polish ? { style: styles.valueUnclamped } : {})}>
                {shapeThai(l.descriptionTh)}
              </Text>
              <Text style={styles.label}>{l.descriptionEn}</Text>
            </View>
            <Text style={styles.tdQty}>{l.quantity}</Text>
            <Text style={styles.tdUnit}>{formatThbSatang(l.unitPrice.satang, polish)}</Text>
            <Text style={styles.tdTotal}>{formatThbSatang(l.total.satang, polish)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.totalsBlock}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{shapeThai('รวมก่อนภาษี')} / Subtotal:</Text>
          <Text style={styles.totalValue}>{formatThbSatang(input.subtotal.satang, polish)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>
            VAT {input.vatRate.toPercentString()}:
          </Text>
          <Text style={styles.totalValue}>{formatThbSatang(input.vat.satang, polish)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={[styles.totalLabel, styles.grand]}>
            {shapeThai('รวมทั้งสิ้น')} / Total (THB):
          </Text>
          <Text style={[styles.totalValue, styles.grand]}>
            {formatThbSatang(input.total.satang, polish)}
          </Text>
        </View>
        {/* 054-event-fee-invoices — VAT-inclusive (event Model B) annotation.
            The single event_fee line carries the GROSS (all-in) ticket price,
            while the subtotal above is the back-calculated NET amount and VAT
            is the derived remainder. Without this label a Thai reader sees a
            line total that doesn't equal the subtotal and could mistake the
            document for an arithmetic error. Bilingual + placed directly under
            the totals so the relationship (line gross = net + VAT) is explicit.
            Membership invoices are VAT-EXCLUSIVE (vatInclusive falsy) → no
            annotation, preserving byte-identical re-render for F4 documents. */}
        {input.vatInclusive && (
          <Text style={styles.vatInclusiveNote}>
            {shapeThai('ราคารวมภาษีมูลค่าเพิ่มแล้ว')} / VAT included
          </Text>
        )}
      </View>

      <Text style={styles.wordsLine}>
        ({shapeThai('ตัวอักษร')}) {shapeThai(amountToThaiWords(totalThb))}
      </Text>
      {/* 088 US4 (T035 / FR-009) — capitalize the English amount-in-words first
          letter at v6. Kept on ONE line + the exact `(…)` literal children so a
          pre-v6 render is byte-identical to the historical output (SC-003). */}
      <Text style={styles.wordsLine}>({polish ? capitalizeFirstLetter(amountToEnglishWords(totalThb)) : amountToEnglishWords(totalThb)})</Text>

      {isCreditAnnotatable &&
        input.creditedAnnotation &&
        input.creditedAnnotation.references.length > 0 && (
          <View style={styles.cnRefFooterBlock}>
            <Text style={styles.cnRefFooterLabel}>
              {shapeThai('อ้างอิงใบลดหนี้')} / Referenced by credit note(s):
            </Text>
            {input.creditedAnnotation.references.map((r) => (
              <View key={r.documentNumber} style={styles.cnRefFooterRow}>
                <Text style={styles.cnRefFooterCell}>{r.documentNumber}</Text>
                <Text style={styles.cnRefFooterCell}>{r.issueDate}</Text>
                <Text style={styles.cnRefFooterCellAmt}>
                  {formatThbSatang(r.total.satang, polish)} THB
                </Text>
              </View>
            ))}
          </View>
        )}

      {/* 088 US5 (T041 / FR-012 / SC-007) — tenant WHT footer note. Renders on
          `invoice_subject='membership'` documents ONLY (bill + tax receipt),
          NEVER event; gated v>=7 so pre-v7 documents re-render byte-stable. Each
          language line guarded independently (a tenant may configure only one). */}
      {input.templateVersion >= WHT_AND_BANK_BLOCK_MIN_VERSION &&
        input.invoiceSubject === 'membership' &&
        (input.tenant.wht_note_th != null || input.tenant.wht_note_en != null) && (
          <View style={styles.whtNoteBlock}>
            {input.tenant.wht_note_th != null && (
              <Text style={styles.whtNoteLine}>
                {/* 093 — the full-width WHT-note block gets a wider Thai wrap
                    budget so the ~68-char note is not force-wrapped onto two
                    lines. Version-gated: a pinned pre-v9 document re-renders at
                    the legacy 55 budget (SC-003 byte-reproduce). */}
                {shapeThai(
                  input.tenant.wht_note_th,
                  input.templateVersion >= WHT_NOTE_WRAP_FIX_MIN_VERSION
                    ? WHT_NOTE_WRAP_THRESHOLD_CHARS
                    : undefined,
                )}
              </Text>
            )}
            {input.tenant.wht_note_en != null && (
              <Text style={styles.whtNoteLine}>{input.tenant.wht_note_en}</Text>
            )}
          </View>
        )}

      {/* 088 US8 (T058 / FR-025 / SC-008) — §80/1(5) embassy / int'l-org
          VAT-zero-rate note. Renders on the §86/4 tax invoice / receipt ONLY
          (NOT the non-tax ใบแจ้งหนี้ bill, which just shows VAT 0% / 0.00), and
          ONLY when the pinned treatment is zero-rated; gated v>=8 so pre-v8
          documents re-render byte-stable (SC-003). Membership is always
          'standard', so the note never draws on a membership document; the
          WHT note (US5, membership-only) never draws on a zero-rate document.

          088 T068 M-2 — `!isBill` alone is INSUFFICIENT for a VOID: a void's
          kind is 'void_stamped_invoice', so `isBill` (requires kind
          invoice/invoice_preview) is FALSE even for a voided ใบแจ้งหนี้ bill —
          which would wrongly print this §-citation note on the VOID copy of a
          NON-tax bill (FR-001 forbids a §-citation on the bill; SC-003). The
          void path passes `billMode:true` ONLY for the bill (Target A); the
          §86/4 receipt void (Target B) + every LIVE receipt do NOT pass it, so
          `billMode !== true` keeps the note on the tax receipt while suppressing
          it on the bill. A LIVE bill is already excluded by `!isBill` (isBill is
          true → the extra term never changes its outcome), so all existing
          non-void renders stay byte-stable → NO template-version bump. */}
      {!isBill &&
        input.billMode !== true &&
        input.templateVersion >= ZERO_RATE_NOTE_MIN_VERSION &&
        input.vatTreatment === 'zero_rated_80_1_5' && (
          <View style={styles.zeroRateNoteBlock}>
            {(() => {
              const note = section8015NoteLines(
                input.zeroRateCertNo ?? null,
                input.zeroRateCertDate ?? null,
              );
              return (
                <>
                  <Text style={styles.zeroRateNoteLine}>{note.citation}</Text>
                  <Text style={styles.zeroRateNoteLine}>{note.certRef}</Text>
                </>
              );
            })()}
          </View>
        )}

      {/* 088 US5 (T042 / FR-022) — offline-payment bank block + signature stamps
          on the ใบแจ้งหนี้ (bill) ONLY (never the paid §86/4 tax receipt); gated
          v>=7. The bank box only renders when ≥1 bank field is configured; the
          signature stamps are BLANK layout fields on every v7 bill. */}
      {isBill && input.templateVersion >= WHT_AND_BANK_BLOCK_MIN_VERSION && (
        <>
          {(input.tenant.bank_payee_name != null ||
            input.tenant.bank_account_no != null ||
            input.tenant.bank_name != null ||
            input.tenant.bank_swift != null ||
            // Fix #12 (whole-feature review) — these 3 fields are RENDERED inside
            // the block (bank_branch/bank_account_type/bank_address below) but
            // were missing from this outer visibility gate, so a tenant that
            // configured ONLY one of them got the whole block suppressed and the
            // admin-entered detail never printed. The block renders when ANY
            // configured bank field is present.
            input.tenant.bank_branch != null ||
            input.tenant.bank_account_type != null ||
            input.tenant.bank_address != null ||
            input.tenant.payment_instructions_th != null ||
            input.tenant.payment_instructions_en != null) && (
            <View style={styles.bankBlock}>
              <Text style={styles.bankLabel}>
                {shapeThai('ช่องทางการชำระเงิน')} / Payment Details
              </Text>
              {input.tenant.bank_payee_name != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('ชื่อบัญชี')} / Payee: {input.tenant.bank_payee_name}
                </Text>
              )}
              {input.tenant.bank_name != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('ธนาคาร')} / Bank: {input.tenant.bank_name}
                </Text>
              )}
              {input.tenant.bank_branch != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('สาขา')} / Branch: {input.tenant.bank_branch}
                </Text>
              )}
              {input.tenant.bank_account_type != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('ประเภทบัญชี')} / Account Type: {input.tenant.bank_account_type}
                </Text>
              )}
              {input.tenant.bank_account_no != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('เลขที่บัญชี')} / Account No.: {input.tenant.bank_account_no}
                </Text>
              )}
              {input.tenant.bank_swift != null && (
                <Text style={styles.bankLine}>SWIFT/BIC: {input.tenant.bank_swift}</Text>
              )}
              {input.tenant.bank_address != null && (
                <Text style={styles.bankLine}>
                  {shapeThai('ที่อยู่ธนาคาร')} / Bank Address: {shapeThai(input.tenant.bank_address)}
                </Text>
              )}
              {input.tenant.payment_instructions_th != null && (
                <Text style={styles.bankInstructions}>
                  {shapeThai(input.tenant.payment_instructions_th)}
                </Text>
              )}
              {input.tenant.payment_instructions_en != null && (
                <Text style={styles.bankInstructions}>
                  {input.tenant.payment_instructions_en}
                </Text>
              )}
            </View>
          )}
          <View style={styles.signatureRow}>
            <View style={styles.signatureCell}>
              <Text style={styles.signatureLabel}>
                {shapeThai('ผู้ออกเอกสาร')} / Issued by
              </Text>
            </View>
            <View style={styles.signatureCell}>
              <Text style={styles.signatureLabel}>
                {shapeThai('ผู้รับเงิน')} / Received by
              </Text>
            </View>
            <View style={styles.signatureCell}>
              <Text style={styles.signatureLabel}>{shapeThai('วันที่')} / Date</Text>
            </View>
          </View>
        </>
      )}

      {/* 088 T016 — the ใบแจ้งหนี้ (bill) carries NO Revenue-Code §-citation
          footer (its legal identity rests on the non-tax title alone).
          088 US5 T041 / FR-012 — from v7 the hardcoded "Rendered by Chamber-OS
          (§-citation)" footer is DROPPED on every kind (replaced by the tenant
          WHT note above). Pre-v7 tax documents KEEP it byte-stable (SC-003). */}
      {!isBill && input.templateVersion < WHT_AND_BANK_BLOCK_MIN_VERSION && (
        <Text style={styles.footer}>
          Rendered by Chamber-OS ({shapeThai(footerCitation)})
        </Text>
      )}
    </>
  );
}

export function InvoiceTemplate(input: PdfRenderInput) {
  const isPreview = input.kind === 'invoice_preview';
  const isVoid = input.kind === 'void_stamped_invoice';
  // 064 Task 12 — kinds whose MAIN blob can be a §86/10-creditable parent and
  // therefore receive the J2 credited-annotation re-render: a bill-first
  // §86/4 'invoice' OR an as-paid combined §86/4+§105ทวิ 'receipt_combined'
  // (issueEventInvoiceAsPaid). The gate stays an explicit allow-list —
  // 'receipt_separate' parents are rejected by the §86/10
  // `receipt_not_creditable` guard before any annotation render, and a §105
  // ใบเสร็จรับเงิน must never carry a credit-note stamp.
  const isCreditAnnotatable =
    input.kind === 'invoice' || input.kind === 'receipt_combined';
  // 088-invoice-tax-flow-redesign (T016) — the pre-payment document is a
  // NON-tax ใบแจ้งหนี้ / Invoice, NOT a §86/4 ใบกำกับภาษี. `billMode` is set by
  // `issueInvoice` ONLY when FEATURE_088_TAX_AT_PAYMENT is on. When absent
  // (legacy flag-off + every pre-088 render) the kind falls through to the
  // historical ใบกำกับภาษี / Tax Invoice title, so old output is byte-identical.
  const isBill =
    (input.kind === 'invoice' || input.kind === 'invoice_preview') &&
    input.billMode === true;
  let titleTh = 'ใบกำกับภาษี';
  let titleEn = 'Tax Invoice';
  if (isBill) {
    titleTh = 'ใบแจ้งหนี้';
    titleEn = 'Invoice';
  } else if (input.kind === 'credit_note') {
    titleTh = 'ใบลดหนี้';
    titleEn = 'Credit Note';
  } else if (input.kind === 'receipt_combined') {
    titleTh = 'ใบกำกับภาษี / ใบเสร็จรับเงิน';
    titleEn = 'Tax Invoice / Official Receipt';
  } else if (input.kind === 'receipt_separate') {
    titleTh = 'ใบเสร็จรับเงิน';
    titleEn = 'Official Receipt';
  } else if (isVoid && input.voidUnderlyingKind === 'receipt_combined') {
    // 064 W1 S31 — kind-true VOID title: the void re-render keeps the
    // TITLE of the document it cancels (the VOID watermark below carries
    // the cancellation). Without this, voiding a legacy §105
    // ใบเสร็จรับเงิน re-rendered the retained §87/3 evidence copy as a
    // ใบกำกับภาษี — mutating its legal identity. ABSENT field (all
    // pre-change renders) falls through to the historical default
    // titles above, so old output is unchanged — no template-version
    // bump needed.
    titleTh = 'ใบกำกับภาษี / ใบเสร็จรับเงิน';
    titleEn = 'Tax Invoice / Official Receipt';
  } else if (isVoid && input.voidUnderlyingKind === 'receipt_separate') {
    titleTh = 'ใบเสร็จรับเงิน';
    titleEn = 'Official Receipt';
  } else if (
    isVoid &&
    input.voidUnderlyingKind === 'invoice' &&
    input.billMode === true
  ) {
    // 088 T068 — kind-true VOID title for a voided NON-tax ใบแจ้งหนี้ bill. A
    // new-flow bill (FEATURE_088_TAX_AT_PAYMENT) carries voidUnderlyingKind
    // 'invoice' (its pdf_doc_kind) — identical to a legacy §86/4 tax-invoice
    // void — so the two are disambiguated by `billMode`, exactly as the LIVE
    // (non-void) title is at line ~825. Without this branch the void re-render
    // of a ใบแจ้งหนี้ would fall through to the default ใบกำกับภาษี / Tax
    // Invoice title (spec § F.3: a voided bill MUST NEVER read "Tax Invoice").
    // ADDITIVE + byte-safe (no template-version bump): no existing void render
    // passes `billMode`, so a legacy §86/4 void (billMode absent) still falls
    // through to the default title — pre-change output is unchanged (SC-003).
    // `isBill` stays FALSE for voids so the bank block / signature stamps /
    // ต้นฉบับ marker never draw on a voided document.
    titleTh = 'ใบแจ้งหนี้';
    titleEn = 'Invoice';
  }
  // Thai-RD §86/4 requires the document to mark whether it is the
  // original or a copy. Previews + voids have their own watermark;
  // all other rendered tax documents are the tenant's ORIGINAL copy.
  // 088 T016 — a ใบแจ้งหนี้ (bill) carries NO ต้นฉบับ/ORIGINAL marker (it is
  // not a §86/4 tax document). Previews + voids already suppress it.
  const originalMarker = isPreview || isVoid || isBill ? null : 'ต้นฉบับ / ORIGINAL';
  // 065 Task 31 (tax-auditor M-D) — kind-aware Revenue-Code citation,
  // gated on template v3+. Versions 1/2 keep the historical
  // unconditional §86/4 string BYTE-FOR-BYTE: every pinned-version
  // re-render path (void overlay, J2 credited annotation, async
  // receipt worker) passes the row's stored `pdf_template_version`
  // here (R3-E4), so the gate is what preserves SC-003 for all
  // already-issued documents. See templates/revenue-code-citation.ts.
  const footerCitation =
    input.templateVersion >= KIND_AWARE_CITATION_MIN_VERSION
      ? revenueCodeCitation(input.kind, input.voidUnderlyingKind)
      : LEGACY_FOOTER_CITATION;

  const totalThb = Number(input.total.satang) / 100;

  // 088 US4 (T035 / T035a / FR-009 / FR-010 / FR-034) — presentation polish gate.
  // Computed ONCE and threaded into both pages of the two-page combined receipt
  // so the Original + Copy stay consistent. Pre-v6 → false → byte-stable legacy
  // output (SC-003), exactly like the citation / two-page / branch-line gates.
  const polish = input.templateVersion >= PRESENTATION_POLISH_MIN_VERSION;

  // 094 (status-watermark-opacity) — faint VOID / CREDITED stamp gate. Computed
  // ONCE and threaded into both pages of a two-page combined receipt's VOID
  // re-render so the stamp is consistent. Pre-v10 → false → byte-stable original
  // prominent stamp (SC-003), exactly like the `polish` / citation / gate above.
  const faintStatusStamp =
    input.templateVersion >= STATUS_STAMP_FAINT_MIN_VERSION;

  const bodyProps = {
    input,
    isPreview,
    isVoid,
    isBill,
    isCreditAnnotatable,
    titleTh,
    titleEn,
    footerCitation,
    totalThb,
    polish,
    faintStatusStamp,
  } satisfies Omit<PageBodyProps, 'copyMarker'>;

  // 088 US2 (T025 / FR-004 / SC-004 / §105ทวิ คู่ฉบับ) — the combined §86/4 tax
  // receipt is issued as ต้นฉบับ (Original) + สำเนา (Copy): two pages in ONE
  // PDF, sharing ONE RC number, rendered ONCE (a single <Document> → one stream
  // → one sha → one blob via the adapter — no second render). Both pages carry
  // the identical body; only the original/copy marker differs. Gated on the
  // pinned templateVersion so a pre-v4 combined receipt (resend / void-overlay /
  // historical re-render) still paginates to a single page (SC-003).
  // 088 US2 review fix (reliability) — the two-page ต้นฉบับ+สำเนา layout must ALSO
  // hold when the combined receipt is re-rendered as its OWN VOID cancellation
  // evidence: the void path passes kind='void_stamped_invoice' +
  // voidUnderlyingKind='receipt_combined' (void-invoice.ts), so a gate keyed only
  // on `kind==='receipt_combined'` collapses the void to ONE page — dropping the
  // §105ทวิ Copy from the retained §87/3 (10-year) cancelled คู่ฉบับ and making it
  // asymmetric with both the 2-page original AND the 2-page CREDITED re-render
  // (which keeps kind='receipt_combined'). The pinned templateVersion still gates
  // it, so a pre-v4 combined void stays 1 page (matches the 1-page doc it cancels
  // → SC-003). Markers stay ต้นฉบับ/สำเนา (the VOID `fixed` watermark repeats on
  // both pages) so a voided คู่ฉบับ mirrors its credited counterpart.
  const isCombinedReceiptLayout =
    input.kind === 'receipt_combined' ||
    (isVoid && input.voidUnderlyingKind === 'receipt_combined');
  if (
    isCombinedReceiptLayout &&
    input.templateVersion >= TWO_PAGE_RECEIPT_COPY_MIN_VERSION
  ) {
    return (
      <Document>
        <Page size="A4" style={styles.page}>
          {renderPageBody({ ...bodyProps, copyMarker: 'ต้นฉบับ / ORIGINAL' })}
        </Page>
        <Page size="A4" style={styles.page}>
          {renderPageBody({ ...bodyProps, copyMarker: 'สำเนา / COPY' })}
        </Page>
      </Document>
    );
  }

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {renderPageBody({ ...bodyProps, copyMarker: originalMarker })}
      </Page>
    </Document>
  );
}

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
    position: 'absolute',
    top: 280,
    left: 120,
    fontSize: 80,
    color: '#eee',
    transform: 'rotate(-30deg)',
    fontWeight: 700,
  },
  // FR-008 — diagonal VOID overlay, bilingual (TH+EN), on EVERY page,
  // 45° rotation, 50% opacity (within the 40-60% band). `position:
  // absolute` + the `fixed` prop on the Text element makes the stamp
  // repeat on every page without interleaving with flow content.
  voidStamp: {
    position: 'absolute',
    top: 300,
    left: 90,
    fontSize: 80,
    color: 'rgba(200,0,0,0.5)',
    fontWeight: 700,
    transform: 'rotate(-45deg)',
  },
  footer: { marginTop: 24, fontSize: 8, color: '#777', textAlign: 'center' },
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
  // VOID stamp pattern (warm red at 35% opacity) so the visual
  // vocabulary is consistent: "this document carries a status-change
  // annotation". Angle, size, and position are IDENTICAL to the VOID
  // stamp so both can never overlap (an invoice cannot be both VOID
  // and CREDITED — state machine makes them mutually exclusive).
  creditedStamp: {
    position: 'absolute',
    top: 260,
    left: 100,
    fontSize: 64,
    color: 'rgba(180,80,0,0.32)',
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

function formatThbSatang(satang: bigint): string {
  const whole = satang / 100n;
  const rem = satang % 100n;
  return `${whole.toString()}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Buddhist Era year helper — CE + 543.
 */
function beYear(isoDate: string | null): string {
  if (!isoDate) return '';
  const year = Number(isoDate.slice(0, 4));
  return (year + 543).toString();
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
  let titleTh = 'ใบกำกับภาษี';
  let titleEn = 'Tax Invoice';
  if (input.kind === 'credit_note') {
    titleTh = 'ใบลดหนี้';
    titleEn = 'Credit Note';
  } else if (input.kind === 'receipt_combined') {
    titleTh = 'ใบกำกับภาษี / ใบเสร็จรับเงิน';
    titleEn = 'Tax Invoice / Official Receipt';
  } else if (input.kind === 'receipt_separate') {
    titleTh = 'ใบเสร็จรับเงิน';
    titleEn = 'Official Receipt';
  }
  // Thai-RD §86/4 requires the document to mark whether it is the
  // original or a copy. Previews + voids have their own watermark;
  // all other rendered tax documents are the tenant's ORIGINAL copy.
  const originalMarker = isPreview || isVoid ? null : 'ต้นฉบับ / ORIGINAL';

  const totalThb = Number(input.total.satang) / 100;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {isPreview && <Text style={styles.watermark}>PREVIEW</Text>}
        {isVoid && (
          <Text fixed style={styles.voidStamp}>
            VOID / {shapeThai('ยกเลิก')}
          </Text>
        )}
        {isCreditAnnotatable && input.creditedAnnotation && (
          <Text style={styles.creditedStamp}>
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
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.h1}>{shapeThai(titleTh)}</Text>
            <Text style={styles.h2}>{titleEn}</Text>
            {originalMarker && (
              <Text style={[styles.label, { fontWeight: 700 }]}>
                {shapeThai(originalMarker)}
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
          <Text style={styles.value}>{shapeThai(input.member.legal_name)}</Text>
          {input.member.tax_id && (
            <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
          )}
          {/*
            055-member-number — the buyer's FORMATTED member number (`SCCM-0042`),
            pinned on the snapshot at ISSUE time (computed from the tenant prefix +
            bare integer), so the buyer block matches the admin/portal/search
            surfaces. Guarded `!== null` (NOT truthy): explicit so a future type
            widen can't silently render `''`/`undefined`, and so a HISTORICAL
            snapshot (pre-feature JSONB → zod `.default(null)`) omits the line,
            preserving SC-003 byte-stable re-render of already-issued documents.
          */}
          {input.member.member_number_display !== null && (
            <Text style={styles.label}>
              {shapeThai('หมายเลขสมาชิก')} / Member No.: {input.member.member_number_display}
            </Text>
          )}
          {input.member.address.split('\n').map((line, i) => (
            <Text key={`buyer-addr-${i}`} style={styles.addrLine}>
              {shapeThai(line)}
            </Text>
          ))}
          {input.member.primary_contact_name && (
            <Text style={styles.label}>
              {shapeThai('ผู้ติดต่อ')} / Contact: {shapeThai(input.member.primary_contact_name)}
            </Text>
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
                <Text>{shapeThai(l.descriptionTh)}</Text>
                <Text style={styles.label}>{l.descriptionEn}</Text>
              </View>
              <Text style={styles.tdQty}>{l.quantity}</Text>
              <Text style={styles.tdUnit}>{formatThbSatang(l.unitPrice.satang)}</Text>
              <Text style={styles.tdTotal}>{formatThbSatang(l.total.satang)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>{shapeThai('รวมก่อนภาษี')} / Subtotal:</Text>
            <Text style={styles.totalValue}>{formatThbSatang(input.subtotal.satang)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              VAT {input.vatRate.toPercentString()}:
            </Text>
            <Text style={styles.totalValue}>{formatThbSatang(input.vat.satang)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, styles.grand]}>
              {shapeThai('รวมทั้งสิ้น')} / Total (THB):
            </Text>
            <Text style={[styles.totalValue, styles.grand]}>
              {formatThbSatang(input.total.satang)}
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
        <Text style={styles.wordsLine}>({amountToEnglishWords(totalThb)})</Text>

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
                    {formatThbSatang(r.total.satang)} THB
                  </Text>
                </View>
              ))}
            </View>
          )}

        <Text style={styles.footer}>
          Rendered by Chamber-OS ({shapeThai('เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4')})
        </Text>
      </Page>
    </Document>
  );
}

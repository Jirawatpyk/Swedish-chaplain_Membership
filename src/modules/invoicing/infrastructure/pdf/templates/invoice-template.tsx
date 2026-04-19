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
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { PdfRenderInput } from '../../../application/ports/pdf-render-port';
import { amountToThaiWords } from '../amount-to-thai';
import { amountToEnglishWords } from '../amount-to-english';

const styles = StyleSheet.create({
  page: { fontFamily: 'Sarabun', fontSize: 10, padding: 36, color: '#111' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  h1: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  h2: { fontSize: 12, fontWeight: 500, marginBottom: 2 },
  label: { fontSize: 9, color: '#555' },
  value: { fontSize: 10 },
  section: { marginBottom: 12 },
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
  watermark: {
    position: 'absolute',
    top: 280,
    left: 120,
    fontSize: 80,
    color: '#eee',
    transform: 'rotate(-30deg)',
    fontWeight: 700,
  },
  voidStamp: {
    position: 'absolute',
    top: 260,
    left: 140,
    fontSize: 90,
    color: 'rgba(200,0,0,0.35)',
    fontWeight: 700,
    transform: 'rotate(-20deg)',
  },
  footer: { marginTop: 24, fontSize: 8, color: '#777', textAlign: 'center' },
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

  const totalThb = Number(input.total.satang) / 100;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {isPreview && <Text style={styles.watermark}>PREVIEW</Text>}
        {isVoid && <Text style={styles.voidStamp}>VOID / ยกเลิก</Text>}

        <View style={styles.headerRow}>
          <View>
            <Text style={styles.h1}>{input.tenant.legal_name_th}</Text>
            <Text style={styles.h2}>{input.tenant.legal_name_en}</Text>
            <Text style={styles.value}>{input.tenant.address_th}</Text>
            <Text style={styles.value}>{input.tenant.address_en}</Text>
            <Text style={styles.label}>เลขประจำตัวผู้เสียภาษี / Tax ID: {input.tenant.tax_id}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.h1}>{titleTh}</Text>
            <Text style={styles.h2}>{titleEn}</Text>
            {input.documentNumber && (
              <Text style={styles.value}>No. {input.documentNumber.raw}</Text>
            )}
            {input.issueDate && (
              <Text style={styles.label}>
                วันที่ / Date: {input.issueDate} (พ.ศ. {beYear(input.issueDate)})
              </Text>
            )}
            {input.dueDate && (
              <Text style={styles.label}>ครบกำหนด / Due: {input.dueDate}</Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>ลูกค้า / Customer</Text>
          <Text style={styles.value}>{input.member.legal_name}</Text>
          {input.member.tax_id && (
            <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
          )}
          <Text style={styles.value}>{input.member.address}</Text>
          {input.member.primary_contact_name && (
            <Text style={styles.label}>
              ผู้ติดต่อ / Contact: {input.member.primary_contact_name}
            </Text>
          )}
        </View>

        <View style={styles.table}>
          <View style={styles.trHead}>
            <Text style={styles.tdDesc}>รายการ / Description</Text>
            <Text style={styles.tdQty}>จำนวน / Qty</Text>
            <Text style={styles.tdUnit}>ราคา / Unit</Text>
            <Text style={styles.tdTotal}>รวม / Total</Text>
          </View>
          {input.lines.map((l) => (
            <View key={l.lineId} style={styles.tr}>
              <View style={styles.tdDesc}>
                <Text>{l.descriptionTh}</Text>
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
            <Text style={styles.totalLabel}>รวมก่อนภาษี / Subtotal:</Text>
            <Text style={styles.totalValue}>{formatThbSatang(input.subtotal.satang)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              VAT {input.vatRate.toPercentString()}:
            </Text>
            <Text style={styles.totalValue}>{formatThbSatang(input.vat.satang)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, styles.grand]}>รวมทั้งสิ้น / Total (THB):</Text>
            <Text style={[styles.totalValue, styles.grand]}>
              {formatThbSatang(input.total.satang)}
            </Text>
          </View>
        </View>

        <Text style={styles.wordsLine}>(ตัวอักษร) {amountToThaiWords(totalThb)}</Text>
        <Text style={styles.wordsLine}>({amountToEnglishWords(totalThb)})</Text>

        <Text style={styles.footer}>
          Rendered by Chamber-OS (ใบเอกสารภาษีเพื่อการอ้างอิงตาม ปรล. §86/4)
        </Text>
      </Page>
    </Document>
  );
}

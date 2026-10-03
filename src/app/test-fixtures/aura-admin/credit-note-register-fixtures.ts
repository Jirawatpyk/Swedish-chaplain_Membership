/**
 * Spec 122 US8c (T847) — invented fixtures for the credit-note and register
 * previews (`?view=credit-notes|credit-note|registers`). Every value is made up.
 */
import type { CreditNoteDetailViewProps } from '@/app/(staff)/admin/credit-notes/_components/credit-note-detail-view';
import type { Invoice, ListCreditNotesRow, ListTaxDocumentRegisterOutput } from '@/modules/invoicing';

export const CREDIT_NOTE_ID = '00000000-0000-4000-8000-0000000c0014';

export const CREDIT_NOTE_ROWS: readonly ListCreditNotesRow[] = [
  ['cn-15', 'CN-2026-000015', '2026-09-24', 'RC-2026-000041', { kind: 'bill', numberRaw: 'SC-2026-000110' }, true, 'Nordic Design Studio Co., Ltd.', '535000', 'Goodwill discount of 5,000 THB + VAT agreed by the board for 2026.'],
  ['cn-14', 'CN-2026-000014', '2026-09-23', 'RC-2026-000038', { kind: 'bill', numberRaw: 'SC-2026-000102' }, false, 'Siam Nordic Trading Co., Ltd.', '1070000', 'Charged the Premium rate; the member qualifies for Large Corporate for this cycle — difference credited.'],
  ['cn-13', 'CN-2026-000013', '2026-09-02', 'RC-2026-000029', { kind: 'bill', numberRaw: 'SC-2026-000091' }, true, 'Baltic Bay Consulting Co., Ltd.', '107000', 'Seminar cancelled by the chamber.'],
  ['cn-12', 'CN-2026-000012', '2026-07-14', 'INV-2026-000052', { kind: 'combined' }, false, 'Fika House Bangkok', '107000', 'Plan downgraded mid-year (pro-rated).'],
  ['cn-11', 'CN-2026-000011', '2026-06-03', 'INV-2026-000044', { kind: 'combined' }, false, 'Midsommar Hospitality Co., Ltd.', '856000', 'Membership discount agreed for 2026.'],
].map(([creditNoteId, documentNumberRaw, issueDate, receiptNumberRaw, related, isRefund, memberLegalName, totalSatang, reason]) => ({
  creditNoteId: creditNoteId as string,
  documentNumberRaw: documentNumberRaw as string,
  issueDate: issueDate as string,
  originalInvoiceId: `inv-${creditNoteId as string}`,
  original: { receiptNumberRaw: receiptNumberRaw as string, related: related as ListCreditNotesRow['original']['related'] },
  isRefund: isRefund as boolean,
  memberLegalName: memberLegalName as string,
  totalSatang: totalSatang as string,
  reason: reason as string,
})) as unknown as readonly ListCreditNotesRow[];

export function creditNoteDetail(state: string | undefined): CreditNoteDetailViewProps {
  return {
    creditNoteId: CREDIT_NOTE_ID,
    documentNumber: state === 'refund' ? 'CN-2026-000015' : 'CN-2026-000014',
    isRefund: state === 'refund',
    issueDate: '2026-09-23',
    issuerLabel: 'malin.berg@swecham.example',
    memberId: 'm-siam-nordic',
    memberName: 'Siam Nordic Trading Co., Ltd.',
    originalDocuments: { receiptNumberRaw: 'RC-2026-000038', related: { kind: 'bill', numberRaw: 'SC-2026-000102' } },
    invoiceHref: '/admin/invoices/inv-cn-14',
    creditAmountSatang: 1_000_000n,
    vatSatang: 70_000n,
    totalSatang: 1_070_000n,
    reason: 'Charged the Premium rate; the member qualifies for Large Corporate for this cycle — difference credited.',
    siblings: state === 'siblings' ? [{ creditNoteId: 'cn-16', documentNumber: 'CN-2026-000016' }] : [],
    noPrimaryContact: state === 'no-primary',
    issuer: {
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thai-Swedish Chamber of Commerce',
      taxId: '0993000555121',
      addressTh: 'ชั้น 14 เลขที่ 63 ถนนวิทยุ แขวงลุมพินี เขตปทุมวัน กรุงเทพฯ 10330',
      addressEn: '14th floor, 63 Wireless Road, Lumphini, Pathum Wan, Bangkok 10330',
    },
    customer: {
      legalName: 'Siam Nordic Trading Co., Ltd.',
      taxId: '0105557004563',
      address: '98 Sathorn Road, Silom, Bang Rak, Bangkok 10500',
      contactEmail: 'erik.johansson@siamnordic.example',
    },
  };
}

const BUYERS = [
  ['Siam Nordic Trading Co., Ltd.', '0105557004563', 3_600_000n],
  ['Scandia Health Partners Ltd.', '0105556012341', 3_600_000n],
  ['Chiang Mai Nordic Crafts Co., Ltd.', '0105549087650', 350_000n],
  ['Nordic Design Studio Co., Ltd.', '0105561034561', 1_600_000n],
  ['Bangkok Freight Nordic Co., Ltd.', '0105552045679', 1_600_000n],
  ['Andaman Marine Tech Co., Ltd.', '0835560011226', 2_600_000n],
] as const;

function registerRows(prefix: 'RC' | 'RE', zeroRate: boolean): Invoice[] {
  return BUYERS.map(([name, taxId, base], i) => {
    const vat = zeroRate ? 0n : (base * 7n) / 100n;
    return {
      invoiceId: `reg-${prefix}-${i}`,
      status: !zeroRate && i === 2 ? 'void' : 'paid',
      receiptDocumentNumberRaw: `${prefix}-2026-0000${38 + i}`,
      paymentDate: `2026-09-${String(12 + i * 2).padStart(2, '0')}`,
      paidAt: null,
      memberIdentitySnapshot: { legal_name: name, tax_id: prefix === 'RE' ? null : taxId },
      subtotal: { satang: base },
      vat: { satang: vat },
      total: { satang: base + vat },
      vatTreatment: zeroRate ? 'zero_rated_80_1_5' : 'standard',
      zeroRateCertNo: zeroRate ? `MFA-${String(400 + i)}` : null,
    } as unknown as Invoice;
  });
}

export function registerOutput(state: string | undefined): ListTaxDocumentRegisterOutput {
  const kind = state === 're' ? 'RE' : 'RC';
  const zeroRate = state === 'zero-rate';
  const rows = state === 'empty' ? [] : registerRows(kind, zeroRate);
  const live = rows.filter((r) => r.status !== 'void');
  const sum = (pick: (r: Invoice) => bigint) => live.reduce((acc, r) => acc + pick(r), 0n);
  const subtotal = sum((r) => r.subtotal?.satang ?? 0n);
  const vat = sum((r) => r.vat?.satang ?? 0n);
  const empty = state === 'empty';
  return {
    rows,
    summary: {
      rowCount: rows.length,
      cancelledCount: rows.length - live.length,
      totalSubtotalSatang: String(subtotal),
      totalVatSatang: String(vat),
      totalSatang: String(subtotal + vat),
    },
    periodOutputVat: empty
      ? { rcVatSatang: '0', reVatSatang: '0', creditNoteVatSatang: '0', combinedVatSatang: '0' }
      : { rcVatSatang: '2254000', reVatSatang: '308000', creditNoteVatSatang: '112000', combinedVatSatang: '2450000' },
    periodStatus: zeroRate ? 'closed_month' : 'month_to_date',
    legacyCombinedCount: 0,
  };
}

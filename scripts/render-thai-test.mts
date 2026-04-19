import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import fs from 'node:fs';

async function main() {
  const dnR = DocumentNumber.of('SC', 2026, 4);
  if (!dnR.ok) throw new Error('dn fail');

  const input: PdfRenderInput = {
    kind: 'invoice_issued' as const,
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      address_th: '123 ถนนสุขุมวิท แขวงคลองตัน เขตคลองเตย กรุงเทพมหานคร 10110',
      address_en: '123 Sukhumvit Rd, Khlong Tan, Khlong Toei, Bangkok 10110',
      tax_id: '0105558000000',
      logo_blob_key: null,
    } as never,
    member: {
      legal_name: 'บริษัท ทดสอบ จำกัด',
      tax_id: '0123456789012',
      address: '456 ถนนพระราม 9 ห้วยขวาง กรุงเทพฯ 10310',
      primary_contact_name: 'ทดสอบ ผู้ติดต่อ',
    } as never,
    documentNumber: dnR.value,
    issueDate: '2026-04-19',
    dueDate: '2026-05-19',
    lines: [
      {
        lineId: asInvoiceLineId('00000000-0000-0000-0000-000000000001'),
        descriptionTh: 'ค่าสมาชิก ปี 2026 (pro-rate 0.7500, ตั้งแต่ 2026-04-19)',
        descriptionEn: 'Membership 2026 (pro-rated 0.7500, from 2026-04-19)',
        unitPrice: Money.fromSatangUnsafe(20_000_000n),
        quantity: '1.0000',
        total: Money.fromSatangUnsafe(15_000_000n),
      },
      {
        lineId: asInvoiceLineId('00000000-0000-0000-0000-000000000002'),
        descriptionTh: 'ค่าลงทะเบียนแรกเข้า',
        descriptionEn: 'Registration fee (one-off)',
        unitPrice: Money.fromSatangUnsafe(500_000n),
        quantity: '1.0000',
        total: Money.fromSatangUnsafe(500_000n),
      },
    ] as never,
    subtotal: Money.fromSatangUnsafe(15_500_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(1_085_000n),
    total: Money.fromSatangUnsafe(16_585_000n),
    templateVersion: 1,
  } as never;

  const out = await reactPdfRenderAdapter.render(input);
  fs.writeFileSync('docs/SC-2026-000004-shapedthai.pdf', out.bytes);
  console.log('rendered', out.bytes.byteLength, 'bytes');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

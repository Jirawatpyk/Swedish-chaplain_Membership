/**
 * Thai PDF QA harness — 5 test cases covering the highest-risk
 * Thai shaping edge-cases for invoices.
 *
 *   Case 1 — `simple` : baseline (first fix verification)
 *   Case 2 — `plc`    : company name ending with "(มหาชน)" + Thai legal
 *                       suffix "จำกัด" — stress test for multiple ำ +
 *                       Thai/Latin parenthesis interaction
 *   Case 3 — `karan`  : PII carrying karan (์) — e.g. "ลิงค์คอร์ปอเรชั่น"
 *   Case 4 — `tones`  : cascading tone + below-vowel — "อัครเดชครุฑ"
 *                       "ซูเปอร์คลีน" "วิทย์กนก"
 *   Case 5 — `long`   : overflow check — long address with multi-tier
 *                       sub-districts + long member name that forces
 *                       wrapping
 *
 * Output: docs/qa/thai-case-{1..5}.pdf
 */
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import fs from 'node:fs';
import path from 'node:path';

type Case = {
  readonly id: string;
  readonly tenant: { legal_name_th: string; address_th: string };
  readonly member: {
    legal_name: string;
    address: string;
    primary_contact_name: string;
  };
  readonly lineDesc: string;
};

const CASES: readonly Case[] = [
  {
    id: '1-simple',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      address_th: '123 ถนนสุขุมวิท แขวงคลองตัน เขตคลองเตย กรุงเทพมหานคร 10110',
    },
    member: {
      legal_name: 'บริษัท ทดสอบ จำกัด',
      address: '456 ถนนพระราม 9 ห้วยขวาง กรุงเทพฯ 10310',
      primary_contact_name: 'ทดสอบ ผู้ติดต่อ',
    },
    lineDesc: 'ค่าสมาชิก ปี 2026 (pro-rate 0.7500, ตั้งแต่ 2026-04-19)',
  },
  {
    id: '2-plc',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      address_th: '999/88 อาคารสำนักงานใหญ่ ถนนวิทยุ แขวงลุมพินี เขตปทุมวัน กรุงเทพฯ 10330',
    },
    member: {
      legal_name: 'บริษัท อักษรพัฒน์เทคโนโลยี จำกัด (มหาชน)',
      address: '88 ถนนสีลม แขวงสีลม เขตบางรัก กรุงเทพมหานคร 10500',
      primary_contact_name: 'ดร. ประจำ จังหวัดดำเนิน',
    },
    lineDesc: 'ค่าบำรุงประจำปี 2569 — แพ็กเกจธรรมดา — พิเศษเฉพาะมหาชน',
  },
  {
    id: '3-karan',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      address_th: 'กรุงเทพมหานคร 10110',
    },
    member: {
      legal_name: 'บริษัท ลิงค์คอร์ปอเรชั่น จำกัด',
      address: 'สำนักงานใหญ่ เลขที่ ๑๒๓ หมู่ ๔',
      primary_contact_name: 'คุณเบ็น ริชาร์ด ลิ้งค์สโตน',
    },
    lineDesc: 'สิทธิ์การใช้โลโก้สมาชิกบนเว็บไซต์ของท่าน',
  },
  {
    id: '4-tones',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      address_th: 'กรุงเทพฯ',
    },
    member: {
      legal_name: 'บริษัท ซูเปอร์คลีนเซอร์วิส จำกัด',
      address: '๒๒๒/๒๒ ซอยวัฒนโยธิน อ.เมือง จ.นนทบุรี ๑๑๐๐๐',
      primary_contact_name: 'นายอัครเดชครุฑธนัย วิทย์กนก',
    },
    lineDesc: 'ค่าบริการทำความสะอาดอาคารสำนักงาน (เดือนที่ ๔)',
  },
  {
    id: '5-long',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      address_th:
        '999/888 อาคารไทย-สวีเดนพลาซ่า ชั้น ๒๕ ถนนสุขุมวิท แขวงคลองเตยเหนือ เขตวัฒนา กรุงเทพมหานคร 10110 ประเทศไทย',
    },
    member: {
      legal_name:
        'บริษัท ไทย-สวีเดนธุรกิจระหว่างประเทศโลจิสติกส์พัฒนา-ทวีคูณ จำกัด (มหาชน) แผนกสมาชิกสัมพันธ์ต่างประเทศ',
      address:
        '๑๒๓/๔๕ ถนนพระราม ๙ แขวงห้วยขวางใต้ เขตห้วยขวาง กรุงเทพมหานคร ๑๐๓๑๐ ประเทศไทย โทรศัพท์ ๐-๒๒๒๒-๓๓๓๓',
      primary_contact_name:
        'คุณประจำ-ดำเนิน วิทย์กนกครุฑอัคร แผนกบริหารสมาชิกระหว่างประเทศ',
    },
    lineDesc:
      'ค่าสมาชิกประจำปีมหาชน 2569 (pro-rate 0.7500 ตั้งแต่วันที่ ๑๙ เมษายน ๒๕๖๙) พร้อมสิทธิประโยชน์พิเศษ ๑๒ รายการ',
  },
];

async function renderOne(c: Case, seq: number): Promise<void> {
  const dnR = DocumentNumber.of('SC', 2026, seq);
  if (!dnR.ok) throw new Error(`dn fail: case ${c.id}`);
  const input: PdfRenderInput = {
    kind: 'invoice_issued' as const,
    tenant: {
      legal_name_th: c.tenant.legal_name_th,
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      address_th: c.tenant.address_th,
      address_en: '',
      tax_id: '0105558000000',
      logo_blob_key: null,
    } as never,
    member: {
      legal_name: c.member.legal_name,
      tax_id: '0123456789012',
      address: c.member.address,
      primary_contact_name: c.member.primary_contact_name,
    } as never,
    documentNumber: dnR.value,
    issueDate: '2026-04-19',
    dueDate: '2026-05-19',
    lines: [
      {
        lineId: asInvoiceLineId('00000000-0000-0000-0000-000000000001'),
        descriptionTh: c.lineDesc,
        descriptionEn: 'Membership 2026 (QA fixture)',
        unitPrice: Money.fromSatangUnsafe(20_000_000n),
        quantity: '1.0000',
        total: Money.fromSatangUnsafe(15_000_000n),
      },
      {
        lineId: asInvoiceLineId('00000000-0000-0000-0000-000000000002'),
        descriptionTh: 'ค่าลงทะเบียนแรกเข้า',
        descriptionEn: 'Registration fee',
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
  fs.mkdirSync('docs/qa', { recursive: true });
  const outPath = path.join('docs', 'qa', `thai-case-${c.id}.pdf`);
  fs.writeFileSync(outPath, out.bytes);
  console.log(`✅ ${outPath} — ${out.bytes.byteLength} bytes`);
}

async function main(): Promise<void> {
  for (let i = 0; i < CASES.length; i++) {
    await renderOne(CASES[i]!, i + 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

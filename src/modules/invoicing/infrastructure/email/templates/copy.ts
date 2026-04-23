/**
 * T108 — F4 auto-email copy matrix.
 *
 * Extracted from `invoice-auto-email.ts` so the React-based templates
 * (one per event-type family) can re-use the same localised strings
 * without duplicating the 7×3 matrix. The plain-text render path
 * also reads from here — no locale lookup is done twice.
 *
 * Locale coverage: EN default, TH + SV verified via i18n CI.
 * Deliberately narrow to email subject + body + CTA copy; any
 * tenant-brand text (e.g. "Thailand-Swedish Chamber of Commerce")
 * lives in `base-layout.tsx` as the email footer, not here.
 */

export type InvoiceAutoEmailEventType =
  | 'invoice_issued'
  | 'invoice_paid'
  | 'invoice_voided'
  | 'credit_note_issued'
  | 'invoice_pdf_resent'
  | 'receipt_pdf_resent'
  | 'credit_note_pdf_resent';

export type InvoiceAutoEmailLocale = 'en' | 'th' | 'sv';

export interface EmailCopy {
  readonly subject: string;
  readonly body: string;
  readonly cta: string;
}

export const COPY: Record<
  InvoiceAutoEmailLocale,
  Record<InvoiceAutoEmailEventType, EmailCopy>
> = {
  en: {
    invoice_issued: {
      subject: 'Your invoice is ready',
      body: 'Your membership invoice has been issued. Click below to download the PDF.',
      cta: 'Download invoice',
    },
    invoice_paid: {
      subject: 'Payment received — receipt attached',
      body: 'We have recorded your payment. Click below to download the receipt PDF.',
      cta: 'Download receipt',
    },
    invoice_voided: {
      subject: 'Invoice {docNumber} has been voided',
      body:
        'Invoice {docNumber} has been voided and is no longer payable. ' +
        'Please disregard any outstanding payment request for this invoice.{reasonClause} ' +
        '{attachmentClause}',
      cta: 'Download voided invoice (VOID)',
    },
    credit_note_issued: {
      subject: 'Credit note issued',
      body: 'A credit note has been issued for your account.',
      cta: 'Download credit note',
    },
    invoice_pdf_resent: {
      subject: 'Invoice PDF (resend)',
      body: 'A fresh copy of your invoice is ready to download.',
      cta: 'Download invoice',
    },
    receipt_pdf_resent: {
      subject: 'Receipt PDF (resend)',
      body: 'A fresh copy of your receipt is ready to download.',
      cta: 'Download receipt',
    },
    credit_note_pdf_resent: {
      subject: 'Credit note PDF (resend)',
      body: 'A fresh copy of your credit note is ready to download.',
      cta: 'Download credit note',
    },
  },
  th: {
    invoice_issued: {
      subject: 'ใบแจ้งหนี้ของท่านพร้อมแล้ว',
      body: 'ระบบได้ออกใบแจ้งหนี้ค่าสมาชิกของท่านเรียบร้อยแล้ว คลิกด้านล่างเพื่อดาวน์โหลด PDF',
      cta: 'ดาวน์โหลดใบแจ้งหนี้',
    },
    invoice_paid: {
      subject: 'ได้รับชำระเงินแล้ว — ใบเสร็จแนบมาด้วย',
      body: 'ระบบบันทึกการชำระเงินของท่านแล้ว คลิกด้านล่างเพื่อดาวน์โหลดใบเสร็จ',
      cta: 'ดาวน์โหลดใบเสร็จ',
    },
    invoice_voided: {
      subject: 'ใบแจ้งหนี้ {docNumber} ถูกยกเลิกแล้ว',
      body:
        'ใบแจ้งหนี้ {docNumber} ถูกยกเลิก เอกสารฉบับนี้ยกเลิกแล้วและไม่ต้องชำระเงิน ' +
        'หากท่านได้รับการเรียกเก็บเงินของใบแจ้งหนี้ฉบับนี้ กรุณาไม่ต้องดำเนินการชำระ{reasonClause} ' +
        '{attachmentClause}',
      cta: 'ดาวน์โหลดใบแจ้งหนี้ที่ยกเลิก (VOID)',
    },
    credit_note_issued: {
      subject: 'ใบลดหนี้ออกเรียบร้อย',
      body: 'ระบบได้ออกใบลดหนี้สำหรับบัญชีของท่าน',
      cta: 'ดาวน์โหลดใบลดหนี้',
    },
    invoice_pdf_resent: {
      subject: 'ใบแจ้งหนี้ (ส่งซ้ำ)',
      body: 'สำเนาใบแจ้งหนี้พร้อมดาวน์โหลด',
      cta: 'ดาวน์โหลดใบแจ้งหนี้',
    },
    receipt_pdf_resent: {
      subject: 'ใบเสร็จ (ส่งซ้ำ)',
      body: 'สำเนาใบเสร็จพร้อมดาวน์โหลด',
      cta: 'ดาวน์โหลดใบเสร็จ',
    },
    credit_note_pdf_resent: {
      subject: 'ใบลดหนี้ (ส่งซ้ำ)',
      body: 'สำเนาใบลดหนี้พร้อมดาวน์โหลด',
      cta: 'ดาวน์โหลดใบลดหนี้',
    },
  },
  sv: {
    invoice_issued: {
      subject: 'Din faktura är klar',
      body: 'Din medlemsfaktura har utfärdats. Klicka nedan för att ladda ner PDF:en.',
      cta: 'Ladda ner faktura',
    },
    invoice_paid: {
      subject: 'Betalning mottagen — kvitto bifogat',
      body: 'Vi har registrerat din betalning. Klicka nedan för att ladda ner kvittot.',
      cta: 'Ladda ner kvitto',
    },
    invoice_voided: {
      subject: 'Faktura {docNumber} har annullerats',
      body:
        'Faktura {docNumber} har annullerats och ska inte längre betalas. ' +
        'Bortse från eventuella betalningspåminnelser för denna faktura.{reasonClause} ' +
        '{attachmentClause}',
      cta: 'Ladda ner annullerad faktura (VOID)',
    },
    credit_note_issued: {
      subject: 'Kreditnota utfärdad',
      body: 'En kreditnota har utfärdats för ditt konto.',
      cta: 'Ladda ner kreditnota',
    },
    invoice_pdf_resent: {
      subject: 'Faktura-PDF (återsänd)',
      body: 'En ny kopia av din faktura är klar att ladda ner.',
      cta: 'Ladda ner faktura',
    },
    receipt_pdf_resent: {
      subject: 'Kvitto-PDF (återsänd)',
      body: 'En ny kopia av ditt kvitto är klar att ladda ner.',
      cta: 'Ladda ner kvitto',
    },
    credit_note_pdf_resent: {
      subject: 'Kreditnota-PDF (återsänd)',
      body: 'En ny kopia av din kreditnota är klar att ladda ner.',
      cta: 'Ladda ner kreditnota',
    },
  },
};

/**
 * PG-2 — attachment-clause copy per locale (FR-036 VOID PDF attachment).
 */
export const ATTACHMENT_CLAUSE: Record<
  InvoiceAutoEmailLocale,
  { readonly withAttachment: string; readonly linkOnly: string }
> = {
  en: {
    withAttachment:
      'A copy of the voided invoice, stamped VOID, is attached for your records.',
    linkOnly:
      'A copy of the voided invoice, stamped VOID, is available for download via the link below for your records.',
  },
  th: {
    withAttachment:
      'ระบบได้แนบสำเนาใบแจ้งหนี้ที่ประทับตรา "ยกเลิก" ไว้กับอีเมลนี้เพื่อใช้อ้างอิง',
    linkOnly:
      'สำเนาใบแจ้งหนี้ที่ประทับตรา "ยกเลิก" พร้อมให้ดาวน์โหลดได้ผ่านลิงก์ด้านล่างเพื่อใช้อ้างอิง',
  },
  sv: {
    withAttachment:
      'En kopia av den annullerade fakturan, stämplad VOID, bifogas för dina register.',
    linkOnly:
      'En kopia av den annullerade fakturan, stämplad VOID, finns att ladda ner via länken nedan för dina register.',
  },
};

/** B-1 / FR-036 — "Reason: <voidReason>" prefix per locale. */
export const REASON_PREFIX: Record<InvoiceAutoEmailLocale, string> = {
  en: ' Reason: ',
  th: ' เหตุผล: ',
  sv: ' Orsak: ',
};

/**
 * F5 FR-027 — "Pay online" CTA copy per locale for the `invoice_issued`
 * (and `invoice_pdf_resent`) email. Rendered only when the sending tenant
 * has `tenant_payment_settings.online_payment_enabled = true`; otherwise
 * the F4 email keeps its single "Download invoice" CTA and this copy is
 * unused.
 *
 * Keys are also mirrored under `email.invoiceIssued.payOnlineCta` in
 * `src/i18n/messages/{en,th,sv}.json` so the trilingual CI coverage check
 * (`pnpm check:i18n`) enforces parity — the template consumes the values
 * from this matrix at render time (the F4 email pipeline does NOT thread
 * `next-intl` into @react-email templates).
 */
export const PAY_ONLINE_CTA: Record<InvoiceAutoEmailLocale, string> = {
  en: 'Pay online now',
  th: 'ชำระเงินออนไลน์',
  sv: 'Betala online',
};

/**
 * Resolve the interpolated subject + body + CTA once per build. The
 * React template + plain-text fallback share this single string so
 * the two rendering paths stay bit-consistent — a divergence between
 * HTML and plain-text would reach the member as two different
 * messages.
 *
 * No HTML-escape happens here: the React template auto-escapes via
 * JSX (React's default), and the plain-text path doesn't need escape.
 * Double-escape in this file would produce `&amp;lt;` in the HTML
 * output.
 */
export interface ResolvedCopy {
  readonly subject: string;
  readonly body: string;
  readonly cta: string;
}

export interface ResolveCopyInput {
  readonly locale: InvoiceAutoEmailLocale;
  readonly eventType: InvoiceAutoEmailEventType;
  readonly documentNumber?: string | undefined;
  readonly hasAttachment?: boolean | undefined;
  readonly voidReason?: string | undefined;
}

export function resolveCopy(input: ResolveCopyInput): ResolvedCopy {
  const copy = COPY[input.locale][input.eventType];
  const docNumber = input.documentNumber ?? '';
  const attachmentVariant = input.hasAttachment === true ? 'withAttachment' : 'linkOnly';
  const attachmentClause = ATTACHMENT_CLAUSE[input.locale][attachmentVariant];

  const trimmedReason = input.voidReason?.trim() ?? '';
  const reasonClause =
    trimmedReason.length > 0 ? `${REASON_PREFIX[input.locale]}${trimmedReason}` : '';

  const interpolate = (s: string): string =>
    s
      .replace(/\{docNumber\}/g, docNumber)
      .replace(/\{attachmentClause\}/g, attachmentClause)
      .replace(/\{reasonClause\}/g, reasonClause);

  return {
    subject: interpolate(copy.subject),
    body: interpolate(copy.body),
    cta: copy.cta,
  };
}

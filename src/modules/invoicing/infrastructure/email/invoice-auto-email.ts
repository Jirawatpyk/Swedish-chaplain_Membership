/**
 * T106 — F4 auto-email template.
 *
 * Rendered by the shared outbox dispatcher (`/api/cron/outbox-dispatch`)
 * when a `notifications_outbox` row with `notification_type =
 * 'invoice_auto_email'` becomes due. Covers the two MVP event types:
 *   - invoice_issued  → "Your invoice is ready"
 *   - invoice_paid    → "Receipt for payment received"
 *
 * Why a download LINK and not an attachment:
 *   - EmailSender.send currently does not carry attachments; adding it
 *     would touch the F1 infrastructure layer.
 *   - Vercel Blob URLs are stable (access: 'public' + unguessable path
 *     prefix per vercel-blob-adapter.ts). Emails therefore stay small
 *     and the link keeps working.
 *   - Spec FR-026 ("member receives the PDF automatically") is
 *     satisfied by a direct download — the admin intent is delivery,
 *     not inline rendering.
 *
 * i18n: we do not have a localised tenant brand yet at this layer;
 * the template reads `locale` from the outbox row and falls back to
 * English. TH/SV strings kept minimal — full templated copy is a
 * Phase-10 polish once US4 tenant-branding settings land.
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

export interface InvoiceAutoEmailInput {
  readonly toEmail: string;
  readonly eventType: InvoiceAutoEmailEventType;
  readonly downloadUrl: string;
  readonly locale: InvoiceAutoEmailLocale;
  /**
   * FR-036 — original document number. Required for `invoice_voided`
   * so the cancellation notice references the exact invoice the
   * member received; optional for other events (backwards-compat).
   */
  readonly documentNumber?: string;
  /**
   * PG-2 — whether the VOID-stamped PDF actually ships as an email
   * attachment (FR-036 full). When FALSE the copy adapts to
   * reference the download link instead of promising an attachment
   * that isn't there. Only read for `invoice_voided`.
   */
  readonly hasAttachment?: boolean;
  /**
   * B-1 / FR-036 — admin-entered void reason, rendered into the
   * `invoice_voided` body. Ignored for other event types. Untrimmed
   * plaintext is fine here: this value is routed through the outbox
   * `context_data` (purged after 90 days per B-2) and does not reach
   * the append-only audit log (that path uses void_reason_sha256).
   */
  readonly voidReason?: string;
}

interface BuiltPayload {
  subject: string;
  html: string;
  text: string;
}

const COPY: Record<
  InvoiceAutoEmailLocale,
  Record<InvoiceAutoEmailEventType, { subject: string; body: string; cta: string }>
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
      // `{attachmentClause}` + `{reasonClause}` are replaced at render
      // time. PG-2 `hasAttachment` flag → attachmentClause;
      // B-1 `voidReason` presence → reasonClause (empty when omitted).
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
 * PG-2 — attachment-clause copy per locale. When the DPA gate is OPEN
 * (`hasAttachment=true`) the body ends with a sentence promising the
 * attached VOID-stamped PDF. When CLOSED the body points at the
 * download link instead, so the member is never told "attached" when
 * the email actually ships link-only.
 */
const ATTACHMENT_CLAUSE: Record<
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

/**
 * B-1 / FR-036 — "Reason: <voidReason>" prefix per locale. Rendered
 * only when `voidReason` is supplied (invoice_voided path). Empty
 * string otherwise so the outer spacing stays clean.
 */
const REASON_PREFIX: Record<InvoiceAutoEmailLocale, string> = {
  en: ' Reason: ',
  th: ' เหตุผล: ',
  sv: ' Orsak: ',
};

/**
 * Minimal HTML-entity escape for user-supplied free text (voidReason)
 * rendered into the email HTML body. Plain-text body does not need
 * escape. Covers the standard 5 (Council of Europe OWASP guidance):
 * `&`, `<`, `>`, `"`, `'`.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInvoiceAutoEmail(input: InvoiceAutoEmailInput): BuiltPayload {
  const copy = COPY[input.locale][input.eventType];
  // FR-036 — substitute the original document number into subject +
  // body. Falls back to the literal placeholder only if the caller
  // supplied none (should never happen for invoice_voided but avoids
  // a thrown error for backwards-compat callers on other event types
  // whose copy doesn't reference {docNumber}).
  const docNumber = input.documentNumber ?? '';
  const attachmentVariant = input.hasAttachment === true ? 'withAttachment' : 'linkOnly';
  const attachmentClause = ATTACHMENT_CLAUSE[input.locale][attachmentVariant];
  // B-1 — render REASON_PREFIX + trimmed voidReason when present.
  // Plain text goes into the `text` output; the HTML output receives
  // an escaped version (user-supplied free text renders inside HTML).
  const trimmedReason = input.voidReason?.trim() ?? '';
  const reasonClausePlain =
    trimmedReason.length > 0 ? `${REASON_PREFIX[input.locale]}${trimmedReason}` : '';
  const reasonClauseHtml =
    trimmedReason.length > 0
      ? `${REASON_PREFIX[input.locale]}${escapeHtml(trimmedReason)}`
      : '';
  const interpolatePlain = (s: string): string =>
    s
      .replace(/\{docNumber\}/g, docNumber)
      .replace(/\{attachmentClause\}/g, attachmentClause)
      .replace(/\{reasonClause\}/g, reasonClausePlain);
  const interpolateHtml = (s: string): string =>
    s
      .replace(/\{docNumber\}/g, docNumber)
      .replace(/\{attachmentClause\}/g, attachmentClause)
      .replace(/\{reasonClause\}/g, reasonClauseHtml);
  const subject = interpolatePlain(copy.subject);
  const bodyPlain = interpolatePlain(copy.body);
  const bodyHtml = interpolateHtml(copy.body);
  const cta = copy.cta;
  const safeUrl = input.downloadUrl;

  const html = `<!DOCTYPE html>
<html lang="${input.locale}">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111">
  <h1 style="font-size: 18px; margin: 0 0 16px">${subject}</h1>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px">${bodyHtml}</p>
  <p style="margin: 0 0 24px">
    <a href="${safeUrl}" style="display: inline-block; padding: 10px 20px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px">${cta}</a>
  </p>
  <p style="font-size: 12px; color: #666; line-height: 1.5">
    If the button does not work, copy this link:<br>
    <a href="${safeUrl}" style="color: #666; word-break: break-all">${safeUrl}</a>
  </p>
</body>
</html>`;

  const text = `${subject}\n\n${bodyPlain}\n\n${cta}: ${safeUrl}`;
  return { subject, html, text };
}

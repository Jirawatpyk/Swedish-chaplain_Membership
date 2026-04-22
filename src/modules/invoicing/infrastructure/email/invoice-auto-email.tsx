/**
 * T108 — F4 auto-email builder (React Email migration).
 *
 * Rendered by the shared outbox dispatcher (`/api/cron/outbox-dispatch`)
 * when a `notifications_outbox` row with
 * `notification_type = 'invoice_auto_email'` becomes due. Covers 7
 * event-type variants mapped onto 4 React Email templates:
 *
 *   invoice_issued        ┐
 *   invoice_pdf_resent    ┘ → InvoiceIssuedEmail
 *   invoice_paid          ┐
 *   receipt_pdf_resent    ┘ → InvoicePaidEmail
 *   invoice_voided        → InvoiceVoidedEmail (docNum + attach + reason)
 *   credit_note_issued    ┐
 *   credit_note_pdf_resent┘ → CreditNoteEmail
 *
 * Why a download LINK and not an inline attachment for non-void
 * events:
 *   - The EmailSender carries attachments only for `invoice_voided`
 *     (PG-2 DPA gate); everything else ships link-only to keep
 *     mailbox size + Resend throughput predictable.
 *   - Vercel Blob URLs are stable (access: 'public' + unguessable path
 *     prefix). Link stays alive for the retention window.
 *
 * Return shape is preserved from the pre-migration inline-HTML
 * version (`{ subject, html, text }`) — dispatcher + unit tests only
 * gain an `await`. The React Email pipeline inlines styles via
 * `juice` for cross-client compat + emits a Gmail-safe preview line.
 */
import { render } from '@react-email/components';
import { InvoiceIssuedEmail } from './templates/invoice-issued';
import { InvoicePaidEmail } from './templates/invoice-paid';
import { InvoiceVoidedEmail } from './templates/invoice-voided';
import { CreditNoteEmail } from './templates/credit-note';
import {
  resolveCopy,
  type InvoiceAutoEmailEventType,
  type InvoiceAutoEmailLocale,
} from './templates/copy';

export type {
  InvoiceAutoEmailEventType,
  InvoiceAutoEmailLocale,
} from './templates/copy';

export interface InvoiceAutoEmailInput {
  readonly toEmail: string;
  readonly eventType: InvoiceAutoEmailEventType;
  readonly downloadUrl: string;
  readonly locale: InvoiceAutoEmailLocale;
  /**
   * FR-036 — original document number. Required for `invoice_voided`
   * so the cancellation notice references the exact invoice the
   * member received; optional for other events.
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

export interface BuiltPayload {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export async function buildInvoiceAutoEmail(
  input: InvoiceAutoEmailInput,
): Promise<BuiltPayload> {
  const copy = resolveCopy({
    locale: input.locale,
    eventType: input.eventType,
    documentNumber: input.documentNumber,
    hasAttachment: input.hasAttachment,
    voidReason: input.voidReason,
  });

  const element = pickTemplate(input.eventType, {
    locale: input.locale,
    subject: copy.subject,
    body: copy.body,
    ctaLabel: copy.cta,
    downloadUrl: input.downloadUrl,
  });

  // React Email's `render()` inlines CSS + returns Gmail-safe HTML.
  // `plainText: true` on a second call would derive the plain-text
  // fallback from the rendered HTML, but our resolved copy is already
  // cleaner than html-to-text stripping (no artefacts from `<br>` or
  // `<a>` boilerplate), so we build `text` manually below.
  const html = await render(element);
  const text = `${copy.subject}\n\n${copy.body}\n\n${copy.cta}: ${input.downloadUrl}`;

  return { subject: copy.subject, html, text };
}

interface TemplateProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly subject: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly downloadUrl: string;
}

function pickTemplate(
  eventType: InvoiceAutoEmailEventType,
  props: TemplateProps,
): React.ReactElement {
  switch (eventType) {
    case 'invoice_issued':
    case 'invoice_pdf_resent':
      return <InvoiceIssuedEmail {...props} />;
    case 'invoice_paid':
    case 'receipt_pdf_resent':
      return <InvoicePaidEmail {...props} />;
    case 'invoice_voided':
      return <InvoiceVoidedEmail {...props} />;
    case 'credit_note_issued':
    case 'credit_note_pdf_resent':
      return <CreditNoteEmail {...props} />;
  }
}

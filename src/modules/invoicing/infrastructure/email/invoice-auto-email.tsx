/** @jsxImportSource react */
/**
 * T108 — F4 auto-email builder (React Email migration).
 *
 * Note on the pragma above: the JSX-runtime override is REQUIRED for
 * Playwright E2E tests that import this module. Playwright 1.59's babel
 * transform hardcodes its own stub jsx-runtime (returns {__pw_type, type,
 * props, key} non-React shells); without the override, render(element)
 * fails with "Objects are not valid as a React child". Vitest/Next.js/
 * tsc are unaffected — they already default to React's jsx-runtime.
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
import * as React from 'react';
import { render } from '@react-email/components';
import { InvoiceIssuedEmail } from './templates/invoice-issued';
import { InvoicePaidEmail } from './templates/invoice-paid';
import { InvoiceVoidedEmail } from './templates/invoice-voided';
import { CreditNoteEmail } from './templates/credit-note';
import {
  PAY_ONLINE_CTA,
  EVENT_NON_MEMBER_FOOTER,
  resolveCopy,
  type InvoiceAutoEmailEventType,
  type InvoiceAutoEmailLocale,
  type PrivacyFooterKind,
} from './templates/copy';

/**
 * F5 FR-027 — UTM attribution query params on the "Pay online" deep link.
 * Pinned here so every email emitted across tenants shares a single
 * attribution signature; changes go through an explicit PR (analytics
 * funnel continuity).
 */
const PAY_ONLINE_UTM =
  'utm_source=invoice_email&utm_medium=email&utm_campaign=f5_pay_online';

/**
 * F5 FR-027 — compose the pay-online deep link. Exported for test
 * parity with the caller; the builder uses this internally.
 */
export function buildPayOnlineUrl(
  portalBaseUrl: string,
  invoiceId: string,
): string {
  const trimmed = portalBaseUrl.replace(/\/+$/, '');
  return `${trimmed}/portal/invoices/${invoiceId}?pay=1&${PAY_ONLINE_UTM}`;
}

export type {
  InvoiceAutoEmailEventType,
  InvoiceAutoEmailLocale,
  PrivacyFooterKind,
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
  /**
   * F5 FR-027 — when `true` AND `payOnlineUrl` is provided, the
   * `invoice_issued` / `invoice_pdf_resent` email renders an additional
   * visually-primary "Pay online" CTA above the PDF-download button.
   * Ignored for all other event types. Caller (outbox dispatcher) MUST
   * resolve this from `tenant_payment_settings.online_payment_enabled`.
   */
  readonly tenantOnlinePaymentEnabled?: boolean;
  /**
   * F5 FR-027 — fully composed pay-online deep link. Use
   * `buildPayOnlineUrl(portalBaseUrl, invoiceId)` to compose; kept as a
   * string prop so this module doesn't need to know about env resolution.
   */
  readonly payOnlineUrl?: string;
  /**
   * 054-event-fee-invoices (Task 14) — PDPA privacy-footer discriminator.
   * `'event_non_member'` renders the §87/3 transparency notice for a
   * non-member event-invoice buyer; omitted/undefined renders no notice
   * (membership + matched-member event invoices). Only the `invoice_issued`
   * / `invoice_pdf_resent` template family renders it (the issue + resend
   * paths for the document whose PII was recorded).
   */
  readonly privacyFooterKind?: PrivacyFooterKind;
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

  // Task 14 — resolve the localised PDPA footer once when the caller asked
  // for the non-member event notice. Kept in the builder (not the template)
  // so the copy source-of-truth stays in `copy.ts` alongside PAY_ONLINE_CTA.
  const privacyFooter =
    input.privacyFooterKind === 'event_non_member'
      ? EVENT_NON_MEMBER_FOOTER[input.locale]
      : undefined;

  const element = pickTemplate(input.eventType, {
    locale: input.locale,
    subject: copy.subject,
    body: copy.body,
    ctaLabel: copy.cta,
    downloadUrl: input.downloadUrl,
    tenantOnlinePaymentEnabled: input.tenantOnlinePaymentEnabled === true,
    ...(typeof input.payOnlineUrl === 'string' && input.payOnlineUrl.length > 0
      ? { payOnlineUrl: input.payOnlineUrl }
      : {}),
    ...(privacyFooter
      ? {
          privacyNoticeTitle: privacyFooter.title,
          privacyNoticeBody: privacyFooter.notice,
        }
      : {}),
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
  /** F5 FR-027 — only consumed by `InvoiceIssuedEmail`. */
  readonly tenantOnlinePaymentEnabled?: boolean;
  /** F5 FR-027 — only consumed by `InvoiceIssuedEmail`. */
  readonly payOnlineUrl?: string;
  /** Task 14 — PDPA footer; only consumed by `InvoiceIssuedEmail`. */
  readonly privacyNoticeTitle?: string;
  readonly privacyNoticeBody?: string;
}

function pickTemplate(
  eventType: InvoiceAutoEmailEventType,
  props: TemplateProps,
): React.ReactElement {
  switch (eventType) {
    case 'invoice_issued':
    case 'invoice_pdf_resent': {
      // F5 FR-027 — thread the pay-online CTA into the issued-invoice
      // template. Other templates don't receive these props.
      const payOnlineCtaLabel = PAY_ONLINE_CTA[props.locale];
      return (
        <InvoiceIssuedEmail
          locale={props.locale}
          subject={props.subject}
          body={props.body}
          ctaLabel={props.ctaLabel}
          downloadUrl={props.downloadUrl}
          tenantOnlinePaymentEnabled={props.tenantOnlinePaymentEnabled === true}
          payOnlineCtaLabel={payOnlineCtaLabel}
          {...(typeof props.payOnlineUrl === 'string' &&
          props.payOnlineUrl.length > 0
            ? { payOnlineUrl: props.payOnlineUrl }
            : {})}
          {...(typeof props.privacyNoticeTitle === 'string' &&
          props.privacyNoticeTitle.length > 0 &&
          typeof props.privacyNoticeBody === 'string' &&
          props.privacyNoticeBody.length > 0
            ? {
                privacyNoticeTitle: props.privacyNoticeTitle,
                privacyNoticeBody: props.privacyNoticeBody,
              }
            : {})}
        />
      );
    }
    case 'invoice_paid':
    case 'receipt_pdf_resent':
      return (
        <InvoicePaidEmail
          locale={props.locale}
          subject={props.subject}
          body={props.body}
          ctaLabel={props.ctaLabel}
          downloadUrl={props.downloadUrl}
        />
      );
    case 'invoice_voided':
      return (
        <InvoiceVoidedEmail
          locale={props.locale}
          subject={props.subject}
          body={props.body}
          ctaLabel={props.ctaLabel}
          downloadUrl={props.downloadUrl}
        />
      );
    case 'credit_note_issued':
    case 'credit_note_pdf_resent':
      return (
        <CreditNoteEmail
          locale={props.locale}
          subject={props.subject}
          body={props.body}
          ctaLabel={props.ctaLabel}
          downloadUrl={props.downloadUrl}
        />
      );
  }
}

/** @jsxImportSource react */
/**
 * T108 — `invoice_issued` + `invoice_pdf_resent` template.
 *
 * One component covers both the initial-issue event and the admin/
 * member-triggered resend because the visual shape is identical —
 * only the subject + body copy differ (handled by `resolveCopy`).
 *
 * F5 FR-027 (2026-04-23) — extended with an optional "Pay online" CTA:
 * when `tenantOnlinePaymentEnabled === true` AND both `payOnlineUrl` +
 * `payOnlineCtaLabel` are provided, the base layout renders a second,
 * visually-primary button ABOVE the existing "Download invoice" CTA.
 * The caller (currently F4's `buildInvoiceAutoEmail` → to be wired up in
 * the F5 US1 slice) is responsible for:
 *   (a) resolving `tenantOnlinePaymentEnabled` from `tenant_payment_settings`
 *   (b) composing `payOnlineUrl` as
 *       `{portalBaseUrl}/portal/invoices/{id}?pay=1&utm_source=invoice_email&utm_medium=email&utm_campaign=f5_pay_online`
 *   (c) selecting the localised label from `PAY_ONLINE_CTA[locale]`
 *       in `./copy.ts`.
 *
 * TODO(F5-US1): caller must thread tenantOnlinePaymentEnabled from
 *   tenant_payment_settings — this template only renders what it is given.
 */
import * as React from 'react';
import { BaseEmailLayout } from './base-layout';
import type { InvoiceAutoEmailLocale } from './copy';

export interface InvoiceIssuedEmailProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly subject: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly downloadUrl: string;
  /**
   * F5 FR-027 — whether the sending tenant has online payment enabled.
   * When `true` AND `payOnlineUrl` + `payOnlineCtaLabel` are supplied,
   * the template renders an additional primary "Pay online" CTA. When
   * `false` (or any required field is missing), behaviour is identical
   * to pre-F5.
   */
  readonly tenantOnlinePaymentEnabled?: boolean;
  /** F5 FR-027 — fully composed pay-online URL including `?pay=1&utm_*`. */
  readonly payOnlineUrl?: string;
  /** F5 FR-027 — localised CTA label (from `PAY_ONLINE_CTA[locale]`). */
  readonly payOnlineCtaLabel?: string;
}

export function InvoiceIssuedEmail(props: InvoiceIssuedEmailProps) {
  const showPayOnline =
    props.tenantOnlinePaymentEnabled === true &&
    typeof props.payOnlineUrl === 'string' &&
    props.payOnlineUrl.length > 0 &&
    typeof props.payOnlineCtaLabel === 'string' &&
    props.payOnlineCtaLabel.length > 0;

  return (
    <BaseEmailLayout
      locale={props.locale}
      previewText={props.subject}
      heading={props.subject}
      bodyContent={props.body}
      ctaLabel={props.ctaLabel}
      ctaHref={props.downloadUrl}
      {...(showPayOnline
        ? {
            primaryCtaLabel: props.payOnlineCtaLabel,
            primaryCtaHref: props.payOnlineUrl,
          }
        : {})}
    />
  );
}

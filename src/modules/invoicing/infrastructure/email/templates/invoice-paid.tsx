/**
 * T108 — `invoice_paid` + `receipt_pdf_resent` template.
 *
 * Covers both the payment-confirmation event and the receipt-resend
 * event. The visual shape is identical; subject + body copy differ
 * via `resolveCopy`.
 */
import * as React from 'react';
import { BaseEmailLayout } from './base-layout';
import type { InvoiceAutoEmailLocale } from './copy';

export interface InvoicePaidEmailProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly subject: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly downloadUrl: string;
}

export function InvoicePaidEmail(props: InvoicePaidEmailProps) {
  return (
    <BaseEmailLayout
      locale={props.locale}
      previewText={props.subject}
      heading={props.subject}
      bodyContent={props.body}
      ctaLabel={props.ctaLabel}
      ctaHref={props.downloadUrl}
    />
  );
}

/**
 * T108 — `invoice_issued` + `invoice_pdf_resent` template.
 *
 * One component covers both the initial-issue event and the admin/
 * member-triggered resend because the visual shape is identical —
 * only the subject + body copy differ (handled by `resolveCopy`).
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
}

export function InvoiceIssuedEmail(props: InvoiceIssuedEmailProps) {
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

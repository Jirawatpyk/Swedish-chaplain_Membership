/** @jsxImportSource react */
/**
 * T108 — `invoice_voided` template (FR-036 cancellation notice).
 *
 * Carries the strongest copy payload of any F4 email:
 *   - document number interpolated into subject + body
 *   - attachment-clause or link-only variant (PG-2 DPA gate)
 *   - admin-entered void reason, HTML-escaped via JSX (React default)
 *
 * `resolveCopy` substitutes all three clauses into the body string
 * before this template renders, so this component just emits the
 * result verbatim via `<BaseEmailLayout>`. JSX auto-escapes `<`, `>`,
 * `&`, `"`, `'` in the body so a malicious void reason cannot break
 * out of the container.
 */
import * as React from 'react';
import { BaseEmailLayout } from './base-layout';
import type { InvoiceAutoEmailLocale } from './copy';

export interface InvoiceVoidedEmailProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly subject: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly downloadUrl: string;
}

export function InvoiceVoidedEmail(props: InvoiceVoidedEmailProps) {
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

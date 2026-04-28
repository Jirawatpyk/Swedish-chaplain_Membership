/** @jsxImportSource react */
/**
 * T108 — `credit_note_issued` + `credit_note_pdf_resent` template.
 *
 * Covers both the initial credit-note issue event and the resend.
 * Visual shape identical; subject + body copy differ via `resolveCopy`.
 */
import * as React from 'react';
import { BaseEmailLayout } from './base-layout';
import type { InvoiceAutoEmailLocale } from './copy';

export interface CreditNoteEmailProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly subject: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly downloadUrl: string;
}

export function CreditNoteEmail(props: CreditNoteEmailProps) {
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

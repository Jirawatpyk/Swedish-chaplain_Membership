/**
 * Spec 122 US8c (T845) — the credit-note detail page body, rendered by the
 * page and by the no-DB preview route (`/test-fixtures/aura-admin?view=
 * credit-note`), board `Admin-credit-note-detail` (spec Session 2026-10-03):
 *
 *   "Credit note {CN-…}" (+ the Refund chip) with Resend email and Download
 *   PDF → the no-primary-contact banner → a Details card (member, issue date,
 *   issued by, original receipt; the amounts at its end) → Reason → the
 *   sibling credit notes → Parties.
 *
 * Every data read and derived value stays in the page; this renders props.
 * Amounts keep the `en-US` grouping and " THB" suffix (FR-005).
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import type { CreditNoteOriginalDocuments } from '@/modules/invoicing';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import {
  CreditNoteOriginalReceipt,
  CreditNoteRefundBadge,
} from '@/components/invoices/credit-note-original-receipt';
import { NoPrimaryContactBanner } from '@/components/members/no-primary-contact-banner';
import { CreditNoteActions } from './credit-note-actions';
import { formatSatangAmount } from '@/lib/format-thb';

function Field({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

export interface CreditNoteDetailViewProps {
  /** The route's `[creditNoteId]`, for the breadcrumb label. */
  readonly creditNoteId: string;
  readonly documentNumber: string;
  /** Issued by the F5 refund flow (`source_refund_id` set). */
  readonly isRefund: boolean;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string;
  /** The issuer's email, or the raw user id when the user is gone. */
  readonly issuerLabel: string;
  /** The original invoice's member; null for an event non-member buyer. */
  readonly memberId: string | null;
  /** The customer's legal name as frozen at issue. */
  readonly memberName: string;
  readonly originalDocuments: CreditNoteOriginalDocuments | null;
  readonly invoiceHref: string;
  readonly creditAmountSatang: bigint;
  readonly vatSatang: bigint;
  readonly totalSatang: bigint;
  readonly reason: string;
  /** Other credit notes on the same invoice, oldest first. */
  readonly siblings: readonly { readonly creditNoteId: string; readonly documentNumber: string }[];
  readonly noPrimaryContact: boolean;
  readonly issuer: {
    readonly legalNameTh: string;
    readonly legalNameEn: string;
    readonly taxId: string;
    readonly addressTh: string;
    readonly addressEn: string;
  };
  readonly customer: {
    readonly legalName: string;
    readonly taxId: string | null;
    readonly address: string;
    readonly contactEmail: string | null;
  };
}


/** Stands in for the number while the title is translated, then is split on. */
const NUMBER_SLOT = '\u0000';

/**
 * The title with the document number kept on one line: "CN-2026-000014"
 * otherwise breaks at a hyphen on a phone. Splitting the translated string
 * keeps each locale's own word order.
 */
function documentTitle(translated: string, number: string) {
  const [before = '', after = ''] = translated.split(NUMBER_SLOT);
  return (
    <>
      {before}
      <span className="whitespace-nowrap">{number}</span>
      {after}
    </>
  );
}

export async function renderCreditNoteDetailView(p: CreditNoteDetailViewProps) {
  const t = await getTranslations('admin.creditNotes.detail');
  const locale = await getLocale();

  return (
    <>
      {/* The breadcrumb reads the CN number in place of the raw id segment. */}
      <PlanBreadcrumbLabel segment={p.creditNoteId} label={p.documentNumber} />
      <PageHeader
        title={documentTitle(t('title', { number: NUMBER_SLOT }), p.documentNumber)}
        {...(p.isRefund ? { badge: <CreditNoteRefundBadge /> } : {})}
        subtitle={t('subtitle')}
        actions={<CreditNoteActions creditNoteId={p.creditNoteId} documentNumber={p.documentNumber} />}
      />

      {p.noPrimaryContact && p.memberId !== null && (
        <NoPrimaryContactBanner memberId={p.memberId} contactsHref={`/admin/members/${p.memberId}`} />
      )}

      <Card title={t('sections.details')} titleId="cn-details-heading" headingLevel={2}>
        <div className="flex flex-col gap-[var(--aura-space-6)]">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('fields.member')}>
              {p.memberId !== null ? (
                <Link
                  href={`/admin/members/${p.memberId}`}
                  className="rounded-xs text-[var(--aura-fg-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
                >
                  {p.memberName}
                </Link>
              ) : (
                p.memberName
              )}
            </Field>
            <Field label={t('fields.issueDate')}>
              <span className="tabular-nums">{formatTaxDocDate(p.issueDate, locale)}</span>
            </Field>
            <Field label={t('fields.issuedBy')}>
              <span className="break-all">{p.issuerLabel}</span>
            </Field>
            <Field label={t('fields.originalReceipt')}>
              {p.originalDocuments ? (
                <CreditNoteOriginalReceipt original={p.originalDocuments} invoiceHref={p.invoiceHref} />
              ) : (
                <span className="text-[var(--aura-fg-secondary)]">—</span>
              )}
            </Field>
          </dl>
          {/* The amounts at the card's end, right-aligned (the US8b totals). */}
          <dl
            data-slot="credit-note-amounts"
            aria-label={t('amountsLabel')}
            className="ms-auto grid w-full grid-cols-[1fr_auto] gap-x-8 gap-y-2 text-sm sm:max-w-sm"
          >
            <dt className="text-[var(--aura-fg-secondary)]">{t('fields.creditAmount')}</dt>
            <dd className="text-end tabular-nums">{formatSatangAmount(p.creditAmountSatang)} THB</dd>
            <dt className="text-[var(--aura-fg-secondary)]">{t('fields.vat')}</dt>
            <dd className="text-end tabular-nums">{formatSatangAmount(p.vatSatang)} THB</dd>
            {/* One rule across the whole row, not one per cell with the gap between. */}
            <div className="col-span-2 grid grid-cols-subgrid border-t border-[var(--aura-border-default)] pt-2 font-semibold">
              <dt>{t('fields.total')}</dt>
              <dd className="text-end tabular-nums">{formatSatangAmount(p.totalSatang)} THB</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card title={t('reason.heading')} titleId="cn-reason-heading" headingLevel={2}>
        <p className="m-0 whitespace-pre-wrap text-sm">{p.reason}</p>
      </Card>

      {/* G-5 — sibling credit notes against the same invoice; hidden when this
          is the only one. */}
      {p.siblings.length > 0 && (
        <nav aria-labelledby="cn-siblings-heading" className="px-1">
          <h2
            id="cn-siblings-heading"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--aura-fg-secondary)]"
          >
            {t('siblings.heading')}
          </h2>
          <ol role="list" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {p.siblings.map((s) => (
              <li key={s.creditNoteId}>
                <Link
                  href={`/admin/credit-notes/${s.creditNoteId}`}
                  className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
                  aria-label={t('siblings.viewLabel', { number: s.documentNumber })}
                >
                  <span className="font-mono">{s.documentNumber}</span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* Parties — identity snapshots are frozen at issue time (FR-038). */}
      <Card title={t('sections.parties')} titleId="cn-parties-heading" headingLevel={2}>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
          <section aria-labelledby="cn-issuer-heading" className="flex flex-col gap-3">
            <h3
              id="cn-issuer-heading"
              className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--aura-fg-secondary)]"
            >
              {t('parties.issuer')}
            </h3>
            <dl className="flex flex-col gap-3">
              <Field label={t('parties.legalName')}>
                <span className="flex flex-col">
                  <span>{p.issuer.legalNameTh}</span>
                  <span className="text-xs text-[var(--aura-fg-secondary)]">{p.issuer.legalNameEn}</span>
                </span>
              </Field>
              <Field label={t('parties.taxId')}>
                <span className="font-mono">{p.issuer.taxId}</span>
              </Field>
              <Field label={t('parties.address')}>
                <span className="flex flex-col">
                  <span>{p.issuer.addressTh}</span>
                  <span className="text-xs text-[var(--aura-fg-secondary)]">{p.issuer.addressEn}</span>
                </span>
              </Field>
            </dl>
          </section>
          <section aria-labelledby="cn-customer-heading" className="flex flex-col gap-3">
            <h3
              id="cn-customer-heading"
              className="m-0 text-xs font-medium uppercase tracking-wide text-[var(--aura-fg-secondary)]"
            >
              {t('parties.customer')}
            </h3>
            <dl className="flex flex-col gap-3">
              <Field label={t('parties.legalName')}>{p.customer.legalName}</Field>
              {p.customer.taxId ? (
                <Field label={t('parties.taxId')}>
                  <span className="font-mono">{p.customer.taxId}</span>
                </Field>
              ) : null}
              <Field label={t('parties.address')}>{p.customer.address}</Field>
              {p.customer.contactEmail ? (
                <Field label={t('parties.contactEmail')}>
                  <span className="break-all">{p.customer.contactEmail}</span>
                  {/* 108 — money emails go to the member's LIVE primary contact. */}
                  {p.memberId !== null ? (
                    <span className="mt-1 block text-xs text-[var(--aura-fg-secondary)]">
                      {t('parties.resendNote')}
                    </span>
                  ) : null}
                </Field>
              ) : null}
            </dl>
          </section>
        </div>
      </Card>
    </>
  );
}

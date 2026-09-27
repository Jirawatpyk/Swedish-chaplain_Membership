/**
 * F4/F5 polish retrospective Phase E (2026-05-17) — portal credit-note
 * detail not-found UI.
 *
 * Rendered when `page.tsx` calls `notFound()` for:
 *   - non-existent creditNoteId (cross-tenant probe audit emitted by
 *     `getCreditNote`)
 *   - same-tenant-different-member case (member-scope check fails)
 *
 * Sibling to `not-found.tsx` in `/portal/invoices/[invoiceId]/` —
 * same Principle I rationale (404 status mandatory for anti-
 * enumeration).
 *
 * Covered by `tests/e2e/smoke-404-status-contract.spec.ts`.
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonClass } from '@jirawatpyk/aura-react/server';

export default async function PortalCreditNoteNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.creditNotes.detail');
  const tInvoices = await getTranslations('portal.invoices');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('meta.title')} />
      <div
        data-testid="portal-credit-note-not-found"
        className="rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-8 text-center"
      >
        <p className="m-0 text-sm text-[var(--aura-fg-secondary)]">{tErrors('notFound')}</p>
        <Link
          href="/portal/invoices"
          className={buttonClass({ variant: 'secondary', size: 'sm', className: 'mt-4' })}
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {tInvoices('title')}
        </Link>
      </div>
    </DetailContainer>
  );
}

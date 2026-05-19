/**
 * F4/F5 polish retrospective Phase E (2026-05-17) — admin credit-note
 * detail not-found UI.
 *
 * Rendered when `page.tsx` calls `notFound()` for:
 *   - non-existent creditNoteId in current tenant (cross-tenant probe
 *     audit emitted by `getCreditNote`)
 *
 * Sibling to `not-found.tsx` in `/admin/invoices/[invoiceId]/`.
 * Same Principle I rationale (404 status mandatory for anti-
 * enumeration). Covered by `tests/e2e/smoke-404-status-contract.spec.ts`.
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';

export default async function AdminCreditNoteNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.creditNotes.list');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div
        data-testid="admin-credit-note-not-found"
        className="rounded-md border p-8 text-center"
      >
        <p className="text-sm text-muted-foreground">{tErrors('notFound')}</p>
        <Link
          href="/admin/credit-notes"
          className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4 inline-flex items-center`}
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('title')}
        </Link>
      </div>
    </DetailContainer>
  );
}

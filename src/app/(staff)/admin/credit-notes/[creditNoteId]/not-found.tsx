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
 * On AURA since spec 122 US8c (T845).
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, EmptyState, Icon, buttonClass } from '@jirawatpyk/aura-react/server';

export default async function AdminCreditNoteNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.creditNotes.list');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      {/* PR Q — AURA's Card holding AURA's EmptyState (frameless, its title a
          paragraph so the page outline is unchanged), the way back its action. */}
      <Card as="div" data-testid="admin-credit-note-not-found">
        <EmptyState
          bordered={false}
          headingLevel={false}
          title={tErrors('notFound')}
          action={
            <Link
              href="/admin/credit-notes"
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
            >
              <Icon name={<ArrowLeft />} size={16} />
              {t('title')}
            </Link>
          }
        />
      </Card>
    </DetailContainer>
  );
}

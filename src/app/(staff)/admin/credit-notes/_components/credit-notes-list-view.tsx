/**
 * Spec 122 US8c (T844) — the credit-notes list page's view, shared by the page
 * and the no-DB preview route (`/test-fixtures/aura-admin?view=credit-notes`),
 * so the screenshots show the page itself. Board `Admin-credit-notes`: the
 * header, the filters (with the count), a quiet Refund legend, then the table
 * in one card (frameless on a phone, where the rows are cards of their own).
 * The page wraps it in its own `TableContainer` (check:layout reads the page).
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import type { ListCreditNotesRow } from '@/modules/invoicing';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { CreditNoteFilters } from './credit-note-filters';
import { CreditNotesTable } from './credit-notes-table';

export interface CreditNotesListViewProps {
  readonly rows: readonly ListCreditNotesRow[];
  /** Matches across every page (the pagination's and the filter row's count). */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasFilters: boolean;
}

export async function renderCreditNotesListView({
  rows,
  total,
  page,
  pageSize,
  hasFilters,
}: CreditNotesListViewProps) {
  const t = await getTranslations('admin.creditNotes.list');
  const tShared = await getTranslations('shared');
  const hasRows = rows.length > 0;

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('description')} />

      {/* One card on a desktop; on a phone the rows are cards of their own, so
          this one drops its frame and padding (the US7a rule). */}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <CreditNoteFilters {...(hasRows || hasFilters ? { resultCount: total } : {})} />
          {hasRows && rows.some((r) => r.isRefund) ? (
            <p data-testid="credit-notes-refund-legend" className="m-0 text-sm text-[var(--aura-fg-secondary)]">
              {t('refundLegend')}
            </p>
          ) : null}
          {hasRows ? (
            <>
              <CreditNotesTable rows={rows} />
              <TablePagination page={page} pageSize={pageSize} total={total} baseHref="/admin/credit-notes" />
            </>
          ) : (
            <EmptyState
              icon={hasFilters ? 'search' : 'file-text'}
              title={hasFilters ? t('filteredEmpty') : t('empty')}
              headingLevel={2}
              action={
                hasFilters ? (
                  // The filter bar's own clear may have scrolled away.
                  <Link href="/admin/credit-notes" className={buttonClass({ variant: 'secondary' })}>
                    {t('actions.clearFilters')}
                  </Link>
                ) : undefined
              }
            />
          )}
        </div>
      </Card>
      <span className="sr-only" role="status" aria-live="polite">
        {tShared('loaded')}
      </span>
    </>
  );
}

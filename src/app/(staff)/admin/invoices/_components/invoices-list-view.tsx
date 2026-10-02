/**
 * Spec 122 US8 (T806) — the invoices list page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=invoices`), so the
 * screenshots show the page itself. Board `Admin-invoices`: the header with
 * "Export CSV" and "New invoice", the filters (with the count), then the table
 * in one card (frameless on a phone, where the rows are cards of their own).
 * `Admin-state-invoices-setup` is {@link renderInvoicesSetupView}. The page
 * wraps both in its own `TableContainer` (check:layout reads the page file).
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon } from 'lucide-react';
import { Alert, Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { InvoicesTable, type InvoicesTableRow } from './invoice-table';
import { InvoiceFilters } from './invoice-filters';
import { InvoicesExportActions } from './invoices-export-actions';

export interface InvoicesListViewProps {
  /** `invoicing.write`: the header actions, Record payment and the queue actions. */
  readonly isAdmin: boolean;
  /** `?origin=auto_renewal` — the review queue's own title and columns. */
  readonly isQueueView: boolean;
  /** 088 T065b — the Registers entry and the three tax-document filters. */
  readonly showRegisters: boolean;
  readonly show088Filters: boolean;
  /** 107 Task 13 — the origin filter (FEATURE_AUTO_INVOICE). */
  readonly showAutoInvoiceFilter: boolean;
  readonly rows: readonly InvoicesTableRow[];
  /** Matches across every page (the pagination's and the filter row's count). */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasFilters: boolean;
  /** No status filter: the default view leaves drafts out, and a quiet line under the filters says where they are. */
  readonly draftsHidden: boolean;
  /** FR-035 — the palette's `?pay=1` deep link. */
  readonly payIntent: boolean;
  /** F5 T096 — `?paidOnline=1`. */
  readonly showMethodColumn: boolean;
  /** The tenant-TZ today for the per-row Record payment date clamp. */
  readonly todayIso: string;
}

export async function renderInvoicesListView({
  isAdmin,
  isQueueView,
  showRegisters,
  show088Filters,
  showAutoInvoiceFilter,
  rows,
  total,
  page,
  pageSize,
  hasFilters,
  draftsHidden,
  payIntent,
  showMethodColumn,
  todayIso,
}: InvoicesListViewProps) {
  const t = await getTranslations('admin.invoices');
  const tShared = await getTranslations('shared');
  const hasRows = rows.length > 0;

  return (
    <>
      <PageHeader
        title={isQueueView ? t('queueView.title') : t('list.title')}
        subtitle={isQueueView ? t('queueView.description') : t('list.description')}
        actions={
          isAdmin ? (
            <>
              {/* 088 T065b (FR-031) — the period tax-document registers for
                  ภ.พ.30; the register page 404s when the flag is off. On a
                  phone it sits in the ⋯ menu with Export CSV… (the US5a
                  members header keeps only its primary action there). */}
              {showRegisters ? (
                <Link
                  href="/admin/invoices/registers"
                  className={buttonClass({ variant: 'secondary', className: 'max-sm:hidden' })}
                >
                  {t('registers.entry')}
                </Link>
              ) : null}
              <InvoicesExportActions showRegisters={showRegisters} />
              <Link
                href="/admin/invoices/new"
                className={buttonClass({ variant: 'primary', className: 'max-sm:order-first' })}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t('list.actions.new')}
              </Link>
            </>
          ) : null
        }
      />

      {/* One card on a desktop; on a phone the rows are cards of their own, so
          this one drops its frame and padding (the US7a rule). */}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <InvoiceFilters
            show088Filters={show088Filters}
            showAutoInvoiceFilter={showAutoInvoiceFilter}
            // Task 3 — generic filter, not flag-gated.
            showDueBeforeFilter
            // The filter pattern: the count at the end of the row, announced
            // politely by AURA's FilterBar. Zero when the filters match
            // nothing; none beside the "no invoices yet" empty state.
            {...(hasRows || hasFilters ? { resultCount: total } : {})}
          />
          {/* The default view leaves drafts out, and "All except drafts" on
              the Status filter says so; this quiet line says where they are.
              Never part of the count, and not a live region. */}
          {hasRows && draftsHidden ? (
            <p data-testid="invoices-drafts-hint" className="m-0 text-sm text-[var(--aura-fg-secondary)]">
              {t('list.draftsHint')}
            </p>
          ) : null}
          {payIntent && isAdmin && hasRows ? (
            // FR-035 — guidance to the per-row Record payment button, not an
            // error: a polite info note.
            <Alert tone="info" role="status" data-testid="record-payment-intent-hint">
              {t('list.recordPaymentIntentHint')}
            </Alert>
          ) : null}
          {hasRows ? (
            <>
              <InvoicesTable
                rows={rows}
                showMethodColumn={showMethodColumn}
                showQueueMetaColumn={isQueueView}
                // 088 T021c / FR-035 and 107 Task 14 — money mutations are
                // admin-only; managers are read-only on finance.
                canRecordPayment={isAdmin}
                canManageQueueActions={isAdmin}
                todayIso={todayIso}
              />
              <TablePagination page={page} pageSize={pageSize} total={total} baseHref="/admin/invoices" />
            </>
          ) : (
            <EmptyState
              icon={hasFilters ? 'search' : 'file-text'}
              title={hasFilters ? t('list.filteredEmpty') : t('list.empty')}
              headingLevel={2}
              action={
                hasFilters ? (
                  // UX-M1 — the filter bar's own clear may have scrolled away.
                  <Link href="/admin/invoices" className={buttonClass({ variant: 'secondary' })}>
                    {t('list.actions.clearFilters')}
                  </Link>
                ) : isAdmin ? (
                  <Link href="/admin/invoices/new" className={buttonClass({ variant: 'primary' })}>
                    <PlusIcon aria-hidden="true" className="size-4" />
                    {t('list.actions.new')}
                  </Link>
                ) : undefined
              }
            />
          )}
        </div>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </>
  );
}

/**
 * R7-B5 / `Admin-state-invoices-setup` — without tenant invoice settings the
 * API refuses to issue (FR-010), so the list says what is missing instead of
 * a dead-end "New invoice". Only an admin can configure it, so only an admin
 * gets the button.
 */
export async function renderInvoicesSetupView({ isAdmin }: { readonly isAdmin: boolean }) {
  const t = await getTranslations('admin.invoices.list');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <EmptyState
          icon="settings"
          title={t('setupRequired')}
          headingLevel={2}
          action={
            isAdmin ? (
              <Link href="/admin/settings/invoicing" className={buttonClass({ variant: 'primary' })}>
                {t('actions.configureInvoicing')}
              </Link>
            ) : undefined
          }
        />
      </Card>
    </>
  );
}

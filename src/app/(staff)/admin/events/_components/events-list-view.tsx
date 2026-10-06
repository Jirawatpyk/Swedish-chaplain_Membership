/**
 * Spec 122 US9a (T901) — the events list page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=events`), so the
 * screenshots show the page itself. Board `Admin-events` (+ `-mobile`): the
 * header with "Erase by email" and "Import CSV", then the filters, table and
 * pager in one list card (docs/aura-adoption.md § List card). The page wraps it
 * in its own `TableContainer` (check:layout reads the page file).
 *
 * `renderEventsListBody` (T906) is the card's content for each state — the
 * load error, or the filters with the table and pager or an empty state —
 * shared the same way.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { EraserIcon, UploadCloudIcon } from 'lucide-react';
import { Alert, Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { EventsListFilters } from '@/components/events/events-list-filters';
import { EventsListTable, type EventsListTableRow } from '@/components/events/events-list-table';
import { EventsEmptyState } from './events-empty-state';
import { EventsHeaderMenu } from './events-header-menu';

export const ERASE_BY_EMAIL_HREF = '/admin/events/erasure';

export interface EventsListViewProps {
  /** `events.write`: the "Import CSV" action (the import page and API admit it). */
  readonly canImport: boolean;
  /** `events.erasure`: "Erase by email" (the key its destination page admits). */
  readonly canEraseByEmail: boolean;
  /** The filters, table and pager — or the empty state, or the load error. */
  readonly children: ReactNode;
}

export async function renderEventsListView({ canImport, canEraseByEmail, children }: EventsListViewProps) {
  const t = await getTranslations('admin.events');
  const actions =
    canImport || canEraseByEmail ? (
      <>
        {canEraseByEmail ? (
          <>
            <Link href={ERASE_BY_EMAIL_HREF} className={buttonClass({ variant: 'secondary', className: 'max-sm:hidden' })}>
              <EraserIcon aria-hidden="true" className="size-4" />
              {t('erasure.discoverabilityCta')}
            </Link>
            <EventsHeaderMenu eraseByEmailHref={ERASE_BY_EMAIL_HREF} />
          </>
        ) : null}
        {canImport ? (
          <Link href="/admin/events/import" className={buttonClass({ variant: 'primary', className: 'max-sm:order-first' })}>
            <UploadCloudIcon aria-hidden="true" className="size-4" />
            {t('list.importCsvCta')}
          </Link>
        ) : null}
      </>
    ) : null;

  return (
    <>
      <PageHeader title={t('list.title')} subtitle={t('list.subtitle')} actions={actions} />
      {/* One card on a desktop; on a phone the rows are cards of their own, so
          this one drops its frame and padding (the list-card rule). */}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        {children}
      </Card>
    </>
  );
}

export type EventsListBodyState =
  | { readonly kind: 'error' }
  | {
      readonly kind: 'list';
      readonly items: readonly EventsListTableRow[];
      readonly pagination: { readonly page: number; readonly pageSize: number; readonly totalCount: number };
      readonly emptyStateContext: Parameters<typeof EventsEmptyState>[0]['emptyContext'];
      /** Any filter in the URL (search, chips, category). */
      readonly hasFilters: boolean;
      /** `settings.integrations`: the empty states' links to the EventCreate settings. */
      readonly canManageIntegration: boolean;
      readonly search: string;
      readonly partnerBenefitOnly: boolean;
      readonly culturalEventOnly: boolean;
      readonly includeArchived: boolean;
    };

export async function renderEventsListBody(state: EventsListBodyState) {
  const t = await getTranslations('admin.events.list');
  if (state.kind === 'error') {
    // A load error keeps its danger frame inside the list card.
    return (
      <Alert tone="danger" role="alert">
        {t('errorState')}
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]">
      {/* The filter pattern: search, three toggle chips, and the count
          (naming the search) as the bar's polite live region. */}
      <EventsListFilters
        search={state.search}
        partnerBenefitOnly={state.partnerBenefitOnly}
        culturalEventOnly={state.culturalEventOnly}
        includeArchived={state.includeArchived}
        // Every match across the pages, as the pager's "of N" says.
        resultCount={state.pagination.totalCount}
      />
      {state.items.length === 0 ? (
        <EventsEmptyState
          emptyContext={state.emptyStateContext}
          hasFilters={state.hasFilters}
          canManageIntegration={state.canManageIntegration}
        />
      ) : (
        <>
          <EventsListTable rows={state.items} />
          {/* The filter bar's count is the list's live region. */}
          <TablePagination
            page={state.pagination.page}
            pageSize={state.pagination.pageSize}
            total={state.pagination.totalCount}
            baseHref="/admin/events"
            live={false}
          />
        </>
      )}
    </div>
  );
}

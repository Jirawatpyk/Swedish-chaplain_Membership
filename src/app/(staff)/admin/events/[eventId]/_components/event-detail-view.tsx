/**
 * Spec 122 US9a (T906) — the event detail page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=event`), so the
 * screenshots show the page itself. Board `Admin-event-detail` (+ `-mobile`):
 *
 *   the page header (the event name) → the summary card with the flag and
 *   archive actions at its end → the attendees list card (heading, filters,
 *   table, pager) → on a phone, the "Event actions" section at the end.
 *
 * The page wraps it in its own `DetailContainer` (check:layout reads the page
 * file) and keeps every read, guard and permission decision.
 */
import { getTranslations } from 'next-intl/server';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { DynamicBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { EventDetailHeader, type EventHeaderProps } from '@/components/events/event-detail-header';
import { EventCategoryToggles } from '@/components/events/event-category-toggles';
import { ArchiveEventButton } from '@/components/events/archive-event-button';
import { AttendeeTable, type AttendeeRow } from '@/components/events/attendee-table';
import type { EventId, PaymentStatus } from '@/modules/events';

export interface EventDetailViewProps {
  readonly event: EventHeaderProps['event'] & { readonly eventId: EventId };
  readonly rows: readonly AttendeeRow[];
  readonly pagination: { readonly page: number; readonly pageSize: number; readonly totalCount: number };
  /** The attendee filters the rows were loaded with (URL `unmatchedOnly`, `q`, `paymentStatus`). */
  readonly filters: {
    readonly unmatchedOnly: boolean;
    readonly q: string | null;
    readonly paymentStatus: PaymentStatus | null;
  };
  /** `events.write` on an event that is not archived: the flag and archive actions (FR-019a). */
  readonly canAct: boolean;
  /** `events.relink` on an event that is not archived: the attendee actions column. */
  readonly canRelink: boolean;
  /** `events.erasure` (super admin): the attendee rows' "Erase personal data". */
  readonly canErase: boolean;
}

export async function renderEventDetailView({
  event,
  rows,
  pagination,
  filters,
  canAct,
  canRelink,
  canErase,
}: EventDetailViewProps) {
  const t = await getTranslations('admin.events.detail');
  const renderActions = () => (
    <>
      <EventCategoryToggles
        eventId={event.eventId}
        isPartnerBenefit={event.isPartnerBenefit}
        isCulturalEvent={event.isCulturalEvent}
      />
      <ArchiveEventButton eventId={event.eventId} />
    </>
  );

  return (
    <>
      {/* Register the event name as the breadcrumb label for the
          dynamic `[eventId]` segment so the trail reads
          "Events / <Event Name>" instead of
          "Events / a1b2c3d4-1234-...". Client component effect runs
          AFTER hydration; intermediate render uses the raw UUID
          briefly (typical <100ms). */}
      <DynamicBreadcrumbLabel segment={event.eventId} label={event.name} />
      <PageHeader title={event.name} subtitle={t('subtitle')} />
      {/* C4-lite (round-10) — the toggles + archive at the summary card's
          end, admin-only per FR-035 and hidden when archived per FR-019a; on
          a phone they move to the "Event actions" section at the page's end
          (board Admin-event-detail-mobile), so the card hides its own copy
          below 640px. */}
      <EventDetailHeader event={event} actions={canAct ? renderActions() : undefined} actionsHiddenBelowSm />
      {/* The attendees list card: the heading, the filter row, the table and
          the pager in one card; on a phone the rows are cards of their own,
          so this one drops its frame (the list-card rule). */}
      <Card
        as="section"
        // h2 under the page h1 (R6-B5); the card is labelled by it.
        title={t('attendees.heading')}
        headingLevel={2}
        titleId="attendees-heading"
        flushBelow="sm"
        className="max-sm:border-0 max-sm:p-0"
      >
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <AttendeeTable
            rows={rows}
            unmatchedOnly={filters.unmatchedOnly}
            initialSearch={filters.q ?? ''}
            {...(filters.paymentStatus !== null && { initialPaymentStatus: filters.paymentStatus })}
            eventId={event.eventId}
            canRelink={canRelink}
            canErase={canErase}
            totalCount={pagination.totalCount}
          />
          <TablePagination
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={pagination.totalCount}
            baseHref={`/admin/events/${event.eventId}`}
            // The filter bar's count is the list's live region.
            live={false}
          />
        </div>
      </Card>
      {canAct ? (
        <section aria-labelledby="event-actions-heading" className="flex flex-col gap-3 sm:hidden">
          <h2 id="event-actions-heading" className="aura-text-label text-[var(--aura-fg-secondary)]">
            {t('header.actionsLabel')}
          </h2>
          <div className="flex flex-col gap-2 [&_button]:w-full">{renderActions()}</div>
        </section>
      ) : null}
    </>
  );
}

/** The load error: the page header, then the message in an AURA danger alert. */
export async function renderEventDetailError() {
  const t = await getTranslations('admin.events.detail');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('errorSubtitle')} />
      <Alert tone="danger" role="alert">
        {t('errorBody')}
      </Alert>
    </>
  );
}

/**
 * T066 — /admin/events/[eventId] detail page skeleton (F6 Phase 4).
 *
 * Spec 122 US9a (T903): the real page's shape on AURA for CLS 0 — the header
 * (the event name is a placeholder, the subtitle is real), the summary card
 * (name, date and category, badges, the actions strip; then the match rate,
 * registrations and last update), then the attendees card with its heading,
 * the filter row and AURA's own table in its loading state with the real columns (cards
 * below 640px, `DataTableSkeleton`).
 *
 * `aria-busy` on the container; `PageSkeletonShell` is the one live region.
 * The placeholder in the `<h1>` slot sits in an `aria-hidden` block span, so
 * a screen reader never meets an empty level-1 heading (R6-W11, R7-A).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import { ATTENDEE_COLUMN_LAYOUT, type AttendeeColumnKey } from '@/components/events/attendee-table-columns';

export default async function EventDetailLoading() {
  const t = await getTranslations('admin.events.detail');
  const tLayout = await getTranslations('layout');
  const columns = (Object.keys(ATTENDEE_COLUMN_LAYOUT) as AttendeeColumnKey[]).map((key) => ({
    key,
    label: t(`attendees.columns.${key}`),
    ...ATTENDEE_COLUMN_LAYOUT[key],
  }));
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer aria-busy="true">
        <PageHeader
          title={
            <span aria-hidden="true" className="block">
              <SkeletonBlock className="h-7 w-72 max-w-full" />
            </span>
          }
          subtitle={t('subtitle')}
        />
        <Card aria-hidden data-skeleton="summary">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* Date and category over the badges; "View on EventCreate" at the end. */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-2">
                <SkeletonBlock className="h-4 w-56 max-w-full" />
                <div className="flex gap-2">
                  <SkeletonBlock className="h-5 w-24 rounded-full" />
                  <SkeletonBlock className="h-5 w-28 rounded-full" />
                </div>
              </div>
              <SkeletonBlock className="h-9 w-44 max-sm:h-11 max-sm:w-full" data-skeleton="eventcreate-link" />
            </div>
            {/* The match-rate figure with its two lines; the registrations and last update. */}
            <div className="flex flex-col gap-4 border-t border-[var(--aura-border-default)] pt-[var(--aura-space-4)] sm:flex-row sm:items-end sm:justify-between">
              <div className="flex flex-col gap-2">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-8 w-28" />
                <SkeletonBlock className="h-4 w-48" />
                <SkeletonBlock className="h-3 w-32" />
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                <SkeletonBlock className="h-4 w-44" />
                <SkeletonBlock className="h-4 w-56" />
              </div>
            </div>
            {/* The flag and archive actions, a strip at the card's end from 640px
                (an admin's view; on a phone they sit at the page's end). */}
            <div
              className="flex flex-wrap gap-2 border-t border-[var(--aura-border-default)] pt-[var(--aura-space-4)] max-sm:hidden"
              data-skeleton="actions"
            >
              <SkeletonBlock className="h-9 w-52" />
              <SkeletonBlock className="h-9 w-52" />
              <SkeletonBlock className="ml-auto h-9 w-36" />
            </div>
          </div>
        </Card>
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The card's "Attendees" heading. */}
            <SkeletonBlock aria-hidden className="h-6 w-32" />
            <div aria-hidden data-skeleton="filters" className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-auto sm:min-w-60 sm:flex-1" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-44" data-skeleton="select" />
              <SkeletonBlock className="h-8 w-48 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="ml-auto h-4 w-20" data-skeleton="result-count" />
            </div>
            <DataTableSkeleton label={t('attendees.tableCaption')} columns={columns} rows={10} />
          </div>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}

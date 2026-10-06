/**
 * Spec 122 US9b-1 (T927) — the deep-link erase page's body on AURA (board
 * `Admin-event-erase-page`), shared by the page and the no-DB preview route.
 * The page keeps its guards (UUID check, `events.erasure`, not found, the
 * redirect for an already-erased row); this only draws the page, with no
 * card, as the board does: the header for the attendee with the hint as its
 * subtitle, then the erase trigger (the same `ErasePiiDialog` the attendee
 * row and the erasure search use) and the way back to the event. The back
 * link shows from `lg`; below it the shell's "← Event" does the same.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { ErasePiiDialog } from '@/components/events/erase-pii-dialog';

export interface ErasePageViewProps {
  readonly eventId: string;
  readonly registrationId: string;
  readonly attendeeName: string;
}

export async function renderErasePageBody({ eventId, registrationId, attendeeName }: ErasePageViewProps) {
  const t = await getTranslations('admin.events.detail.erase');
  return (
    <>
      <PageHeader title={t('pageTitle', { attendeeName })} subtitle={t('pageHint')} />
      <div className="flex flex-wrap items-center gap-[var(--aura-space-4)] max-sm:flex-col max-sm:items-stretch max-sm:[&>button]:w-full">
        <ErasePiiDialog eventId={eventId} registrationId={registrationId} attendeeName={attendeeName} />
        <Link
          href={`/admin/events/${eventId}`}
          className="inline-flex items-center gap-1 text-sm text-[var(--aura-fg-accent)] hover:underline max-lg:hidden"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t('pageBackToEventLabel')}
        </Link>
      </div>
    </>
  );
}

/**
 * Spec 122 US9b-1 (T927) — the deep-link erase page's body on AURA (board
 * `Admin-event-erase-page`), shared by the page and the no-DB preview route.
 * The page keeps its guards (UUID check, `events.erasure`, not found, the
 * redirect for an already-erased row); this only draws the page: the header
 * for the attendee, then one card with the hint, the erase trigger (the same
 * `ErasePiiDialog` the attendee row and the erasure search use) and the way
 * back to the event.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
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
      <PageHeader title={t('pageTitle', { attendeeName })} />
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <p className="aura-text-body text-[var(--aura-fg-secondary)]">{t('pageHint')}</p>
          <div className="flex flex-wrap items-center gap-[var(--aura-space-3)] max-sm:flex-col max-sm:items-stretch max-sm:[&>*]:w-full">
            <ErasePiiDialog eventId={eventId} registrationId={registrationId} attendeeName={attendeeName} />
            <Link
              href={`/admin/events/${eventId}`}
              className={buttonClass({ variant: 'ghost', size: 'sm', touchHeight: true })}
            >
              {t('pageBackToEventLabel')}
            </Link>
          </div>
        </div>
      </Card>
    </>
  );
}

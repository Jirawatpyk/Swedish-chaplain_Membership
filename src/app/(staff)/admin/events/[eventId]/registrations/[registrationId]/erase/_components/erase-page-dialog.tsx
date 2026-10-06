/**
 * The deep-link erase page's dialog: open on arrival, as the page hint says,
 * and back to the event once the erase succeeds. The erase deletes the
 * registration, so refreshing this page would land on a 404.
 */
'use client';

import { useRouter } from 'next/navigation';
import { ErasePiiDialog } from '@/components/events/erase-pii-dialog';

export function ErasePageDialog({
  eventId,
  registrationId,
  attendeeName,
}: {
  readonly eventId: string;
  readonly registrationId: string;
  readonly attendeeName: string;
}) {
  const router = useRouter();
  return (
    <ErasePiiDialog
      eventId={eventId}
      registrationId={registrationId}
      attendeeName={attendeeName}
      defaultOpen
      onErased={() => router.push(`/admin/events/${eventId}`)}
    />
  );
}

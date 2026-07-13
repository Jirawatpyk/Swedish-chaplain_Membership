'use client';

/**
 * Gap B (2026-07-12) — small client wrapper that gives the payment-timeline
 * pending-refund state a polite screen-reader announcement.
 *
 * The timeline `<Card>` is a Server Component and stays `role="region"`
 * only: putting `aria-live` on it would re-announce the WHOLE timeline on
 * every soft-nav remount. This wrapper instead owns a tiny live region that
 * carries just the short "settling" line.
 *
 * The message is written into the region in an effect (empty on the first
 * paint, then set) so the region MUTATES after mount — screen readers
 * announce subsequent mutations of a live region, not content already
 * present at initial render. The region is visually hidden (`sr-only`); the
 * settling state is shown sighted via the warning-tone timeline row.
 */
import { useEffect, useState } from 'react';

export function RefundPendingAnnouncer({
  message,
}: {
  readonly message: string;
}) {
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    setAnnounced(message);
  }, [message]);

  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announced}
    </p>
  );
}

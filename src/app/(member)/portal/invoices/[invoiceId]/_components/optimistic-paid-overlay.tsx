'use client';

/**
 * `<OptimisticPaidOverlay>` — pre-rendered badge swap driven by
 * the optimistic-paid signal (see `./optimistic-paid.ts` for the
 * store + dispatcher rationale).
 *
 * The page is a React Server Component; function children can't
 * cross the server→client boundary, so the server pre-renders BOTH
 * variants and ships them as serialisable `whenUnpaid` / `whenPaid`
 * JSX props. This component picks one based on the
 * `useOptimisticPaid` hook subscription.
 *
 * Single side-effect: when a different tab broadcasts a paid
 * signal, this component fires `router.refresh()` so the
 * server-rendered RSC tree catches up. The dispatching tab's own
 * `router.refresh()` lives in PaySheet's settled-effect — single
 * fire per cause, never both, preserving the multi-fire-session-
 * drop fix.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { useOptimisticPaid } from './optimistic-paid';

export interface OptimisticPaidOverlayProps {
  readonly invoiceId: string;
  readonly whenUnpaid: React.ReactNode;
  readonly whenPaid: React.ReactNode;
}

export function OptimisticPaidOverlay({
  invoiceId,
  whenUnpaid,
  whenPaid,
}: OptimisticPaidOverlayProps) {
  const router = useRouter();
  // Stable callback so `useOptimisticPaid`'s subscribe identity stays
  // fixed across renders. An inline arrow would re-subscribe (and
  // re-create the BroadcastChannel) on every parent re-render.
  const onCrossTabPaid = useCallback(() => router.refresh(), [router]);
  const optimisticallyPaid = useOptimisticPaid(invoiceId, { onCrossTabPaid });

  // `display:contents` so the wrapper drops out of the box tree —
  // children render as direct children of the parent (preserves any
  // `w-full` block layout on the wrapped node). aria-live + aria-atomic
  // are still announced by AT on a `display:contents` element per
  // WAI-ARIA spec, satisfying WCAG 2.1 SC 4.1.3 Status Messages on
  // the badge swap.
  return (
    <span aria-live="polite" aria-atomic="true" className="contents">
      {optimisticallyPaid ? whenPaid : whenUnpaid}
    </span>
  );
}


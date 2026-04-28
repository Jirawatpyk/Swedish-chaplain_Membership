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
import { useTranslations } from 'next-intl';

import { useOptimisticPaid } from './optimistic-paid';
import { LiveRegion } from '@/components/ui/live-region';

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
  const t = useTranslations('portal.invoices.detail.a11y');
  // Stable callback so `useOptimisticPaid`'s subscribe identity stays
  // fixed across renders. An inline arrow would re-subscribe (and
  // re-create the BroadcastChannel) on every parent re-render.
  const onCrossTabPaid = useCallback(() => router.refresh(), [router]);
  const optimisticallyPaid = useOptimisticPaid(invoiceId, { onCrossTabPaid });

  // R3 UX H-1 (2026-04-28): visual swap uses `display:contents`
  // (zero box-tree footprint), but `display:contents` aria-live
  // regions are NOT reliably announced by JAWS Browse mode and
  // VoiceOver-iOS (no presentation node in the AT tree). Pair with
  // a sibling `<LiveRegion>` that has a real DOM node so AT picks
  // up the badge transition.
  return (
    <>
      <span className="contents">
        {optimisticallyPaid ? whenPaid : whenUnpaid}
      </span>
      <LiveRegion politeness="polite">
        {optimisticallyPaid ? t('optimisticPaid') : ''}
      </LiveRegion>
    </>
  );
}


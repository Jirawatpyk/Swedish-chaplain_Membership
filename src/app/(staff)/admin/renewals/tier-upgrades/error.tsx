'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * WP8 (BP5 item 7) — segment-scoped error boundary for the tier-upgrade queue
 * (`/admin/renewals/tier-upgrades`).
 *
 * The nearest ancestor boundary was `admin/error.tsx`, which would blank the
 * whole admin shell (sidebar + top nav) on a throw from this page's data load.
 * This stops the error at the page, inside the same `TableContainer` the page
 * uses so there is no layout width jump.
 *
 * 122 US7b-1 (T726): the shared AURA RouteErrorPanel (error id and Retry), as
 * every migrated route shows a failure.
 */
export default function TierUpgradesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[renewals/tier-upgrades error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

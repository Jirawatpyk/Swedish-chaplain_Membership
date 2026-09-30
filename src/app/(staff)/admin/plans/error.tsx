'use client';

/**
 * Segment-level error boundary for `/admin/plans` (list page).
 *
 * Renders inside `<TableContainer>` (96rem) to match the list page's
 * width so an exception on a wide-table fetch (Neon timeout, RLS
 * misconfig, taxPolicy bootstrap missing) doesn't render in the
 * parent `/admin/error.tsx`'s `<DetailContainer>` (72rem) — that
 * width mismatch was post-ship R6 I12. Sidebar + top bar remain
 * usable via the staff shell layout.
 *
 * 122 US6 (T608): the shared AURA RouteErrorPanel (error id and Retry), as
 * every migrated route shows a failure.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function PlansListError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[admin/plans error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

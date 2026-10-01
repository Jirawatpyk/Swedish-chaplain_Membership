'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * 122 US7b-2 (T735) — segment-scoped error boundary for the escalation tasks
 * queue (`/admin/renewals/tasks`). Without it the nearest boundary was
 * `admin/error.tsx`, which blanks the whole admin shell on a throw from this
 * page's data load. It stops the error at the page, inside the page's own
 * `TableContainer`, with the shared AURA RouteErrorPanel (error id and Retry).
 */
export default function TasksError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[renewals/tasks error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

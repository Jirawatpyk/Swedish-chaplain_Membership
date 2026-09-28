'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F114 — segment-scoped error boundary for `/admin/change-requests` (the
 * queue). A repo failure THROWS from the page (never renders as "no requests
 * are waiting" — review UX C3) and lands here, keeping the admin shell
 * (sidebar + top nav) intact. Same TableContainer as page.tsx (check:layout).
 */
export default function ChangeRequestsQueueError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tQueue = useTranslations('admin.changeRequests.queue');

  useEffect(() => {
    console.error('[admin/change-requests error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={tQueue('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

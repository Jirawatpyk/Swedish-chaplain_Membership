'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function BroadcastQueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const tQueue = useTranslations('admin.broadcasts.queue');

  useEffect(() => {
    console.error('[admin/broadcasts error boundary]', error);
  }, [error]);

  // Spec 122 US12b — the shared AURA error panel (generic message, error id,
  // retry), as every migrated route.
  return (
    <TableContainer>
      <PageHeader title={tQueue('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

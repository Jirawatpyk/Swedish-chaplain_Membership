'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * 124 — segment error boundary for `/admin/finance`. The card loaders never
 * throw (a failed card shows its own reference id); this catches what runs
 * before them — the tenant's fiscal start month, the plan list — and keeps
 * the admin shell intact. Same container as the page (check:layout).
 */
export default function InvoiceDashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('admin.invoiceDashboard');

  useEffect(() => {
    console.error('[admin/finance error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}

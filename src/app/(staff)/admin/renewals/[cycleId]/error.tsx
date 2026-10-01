'use client';

/**
 * Segment error boundary for `/admin/renewals/[cycleId]` (spec 122 US7b-1, UX
 * review L10): a throw from the cycle read stops at the page, inside the same
 * `DetailContainer` the page uses, instead of the admin-wide boundary. The
 * shared AURA RouteErrorPanel shows the error id and Retry, as every migrated
 * route does.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function CycleDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[admin/renewals/[cycleId] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}

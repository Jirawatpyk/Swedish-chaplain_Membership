'use client';

/**
 * Segment-level error boundary for `/admin/plans/[year]/[planId]`
 * (detail page).
 *
 * Renders inside `<DetailContainer>` (72rem) to match the detail page's
 * width. Post-ship R6 I12.
 *
 * 122 US6 (T608): the shared AURA RouteErrorPanel (error id and Retry), as
 * every migrated route shows a failure.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function PlanDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[admin/plans/[year]/[planId] error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}

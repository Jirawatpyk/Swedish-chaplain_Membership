'use client';

/**
 * Segment-level error boundary for `/admin/plans/clone` (form page).
 *
 * Renders in the clone wizard's own form column (`FormContainer`, 720px, at
 * the start edge). Post-ship R6 I12.
 *
 * 122 US6 (T608): the shared AURA RouteErrorPanel (error id and Retry), as
 * every migrated route shows a failure.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function PlansCloneError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[admin/plans/clone error boundary]', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}

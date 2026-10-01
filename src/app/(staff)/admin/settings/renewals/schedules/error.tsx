'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * 122 US7b-2 (T738) — segment-scoped error boundary for the reminder schedules
 * (`/admin/settings/renewals/schedules`). Without it the nearest boundary was
 * `admin/error.tsx`, which blanks the whole admin shell on a throw. It stops
 * the error at the page, inside the page's own `FormContainer`, with the
 * shared AURA RouteErrorPanel (error id and Retry).
 */
export default function SchedulesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[settings/renewals/schedules error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}

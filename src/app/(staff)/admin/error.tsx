'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * Route-level error boundary for the entire staff portal
 * (`/admin/**`). Catches runtime exceptions from server components
 * (e.g. Neon timeout in `UsersDataSection`, `PlansList`, or any future
 * data fetch) and renders a recoverable error page inside the staff
 * shell so the sidebar + top bar remain usable.
 *
 * Next.js requires this to be a Client Component — `error.tsx` must
 * expose `reset()` which only runs client-side.
 *
 * 122 US12d-1 (T1232): the shared AURA RouteErrorPanel (error id and
 * Retry), as every migrated route shows a failure (board `Admin-state-error`).
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    // Surface once so the user's console correlates with server logs
    // via `error.digest`.
    console.error('[admin error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}

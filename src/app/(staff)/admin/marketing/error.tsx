'use client';

/**
 * Route-level error boundary for /admin/marketing/** (108 PR-D review L3).
 * A runtime throw that escapes the Result channel in `listMarketingAudience`
 * (e.g. a Neon read failure on the contacts ⋈ members join) renders a
 * recoverable, page-scoped error with a Retry CTA + the `error.digest` to
 * correlate with server logs — instead of the generic staff-shell boundary
 * (ux-standards § 4.3). Spec 122 US12a: the shared `RouteErrorPanel`, inside
 * the same TableContainer as the audience page (check:layout).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[marketing error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

'use client';

/**
 * Route-level error boundary for /admin/directory. A runtime throw in
 * `searchDirectory` / `listDirectoryExports` that escapes the Result channel
 * (e.g. a Neon read failure on the JOIN) renders a recoverable, page-scoped
 * error with a Retry CTA + the `error.digest` to correlate with server logs —
 * instead of the generic staff-shell boundary (ux-standards § 4.3).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function DirectoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[directory error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

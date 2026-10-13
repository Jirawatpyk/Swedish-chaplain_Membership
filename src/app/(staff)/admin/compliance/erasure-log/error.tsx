'use client';

/**
 * Route-level error boundary for /admin/compliance/erasure-log. A runtime
 * throw while reading the erasure evidence renders a recoverable, page-scoped
 * error with a Retry CTA and the `error.digest` to correlate with server logs,
 * keeping the staff shell intact.
 *
 * Spec 122 US10b (T1017): the shared AURA `RouteErrorPanel`, in the page's
 * TableContainer (check:layout).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function ErasureLogError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');

  useEffect(() => {
    console.error('[erasure-log error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

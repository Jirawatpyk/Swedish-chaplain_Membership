'use client';

/**
 * Route-level error boundary for /admin/audit. A runtime throw in `auditQuery`
 * that escapes the Result channel (e.g. a Neon read failure on the keyset
 * query) renders a recoverable, page-scoped error with a Retry CTA + the
 * `error.digest` to correlate with server logs — instead of the generic
 * staff-shell boundary (ux-standards § 4.3). Must be a Client Component.
 *
 * Spec 122 US10b (T1013): the shared AURA `RouteErrorPanel`, in the page's
 * TableContainer (check:layout).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('admin.audit');

  useEffect(() => {
    console.error('[audit error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

'use client';

/**
 * ux I6 (R1 — enterprise-ux-designer) — Next.js route-level error
 * boundary for /admin/events/import/history.
 *
 * Catches unhandled promise rejections + middleware failures that the
 * page.tsx inline `!result.ok` guard cannot intercept. Renders inside
 * the chamber shell so the admin doesn't bounce to the default Next.js
 * error page. Spec 122 US9b-2 (T938): the shared AURA `RouteErrorPanel`
 * (`role="alert"`, the error id, Retry), as the other migrated routes use.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function CsvImportHistoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('admin.events.import.history');

  useEffect(() => {
    console.error('[F6.1] csv-import history error boundary', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

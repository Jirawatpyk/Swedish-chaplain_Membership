'use client';

/**
 * ux I6 (R1 — enterprise-ux-designer) — Next.js route-level error
 * boundary for /admin/events/import/history.
 *
 * Catches unhandled promise rejections + middleware failures that the
 * page.tsx inline `!result.ok` guard cannot intercept. Renders inside
 * the chamber shell so the admin doesn't bounce to the default
 * Next.js error page. role="alert" is used (assertive live region)
 * so screen readers announce the error immediately per WCAG SC 4.1.3.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

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
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-6"
        role="alert"
      >
        <div className="space-y-1">
          <p className="text-body">{t('loadError')}</p>
          {error.digest ? (
            <p className="text-xs font-mono text-muted-foreground">
              {error.digest}
            </p>
          ) : null}
        </div>
        <Button type="button" onClick={reset} className="min-h-11">
          {t('loadErrorRetry')}
        </Button>
      </div>
    </TableContainer>
  );
}

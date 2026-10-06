'use client';

/**
 * F6 remediation PR 2.2 / P4 — route-level error boundary for the
 * erase-by-email page. Catches unhandled exceptions that escape page.tsx's
 * try/catch (Neon outage during tenant resolution, etc). Uses `TableContainer`
 * to match `page.tsx` + `loading.tsx` so `pnpm check:layout` accepts the
 * container pair. Spec 122 US9b-1 (T926): the shared AURA `RouteErrorPanel`
 * (`role="alert"`, the error id, Retry), as the other migrated routes use it.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function EraseByEmailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('admin.events.erasure');

  useEffect(() => {
    console.error('[F6] erase-by-email page error boundary', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('errorTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

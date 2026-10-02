'use client';

/**
 * Route-level error boundary for /admin/invoices (+ its sub-routes: new/,
 * [invoiceId]/, void/, credit-notes/new/). A runtime throw in the invoice
 * list/detail data fetch that escapes the Result channel (e.g. a Neon read
 * failure) renders a recoverable, page-scoped error with a Retry CTA + the
 * `error.digest` to correlate with server logs — instead of falling through to
 * the generic staff-shell boundary (ux-standards § 4.3). Spec 122 US8 (T806):
 * the shared AURA `RouteErrorPanel`, as the renewals routes use it. Must be a
 * Client Component (Next.js requires `error.tsx` to expose client-side
 * `reset()`).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[invoices error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

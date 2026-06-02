'use client';

/**
 * Route-level error boundary for /admin/invoices (+ its sub-routes: new/,
 * [invoiceId]/, void/, credit-notes/new/). A runtime throw in the invoice
 * list/detail data fetch that escapes the Result channel (e.g. a Neon read
 * failure) renders a recoverable, page-scoped error with a Retry CTA + the
 * `error.digest` to correlate with server logs — instead of falling through to
 * the generic staff-shell boundary (ux-standards § 4.3). Mirrors the directory/
 * audit siblings. Must be a Client Component (Next.js requires `error.tsx` to
 * expose client-side `reset()`).
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[invoices error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('generic')} />
      <Card>
        <CardHeader className="flex flex-row items-start gap-3">
          <AlertCircleIcon className="size-6 text-destructive" aria-hidden />
          <div>
            <CardTitle>{t('generic')}</CardTitle>
            <CardDescription>
              {error.digest ? t('errorId', { id: error.digest }) : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={reset}>{tButtons('retry')}</Button>
        </CardContent>
      </Card>
    </TableContainer>
  );
}

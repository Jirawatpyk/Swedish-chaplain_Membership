'use client';

/**
 * Route-level error boundary for /admin/compliance/erasure-log. A runtime throw
 * in `getErasureEvidenceLog` (e.g. a Neon read failure on the union query)
 * renders a recoverable, page-scoped error with a Retry CTA + the `error.digest`
 * to correlate with server logs — instead of the generic staff-shell boundary
 * (ux-standards § 4.3). Must be a Client Component.
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

export default function ErasureLogError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[erasure-log error boundary]', error);
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

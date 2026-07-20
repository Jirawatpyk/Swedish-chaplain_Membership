'use client';

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

/**
 * WP8 (BP5 item 7) — segment-scoped error boundary for the tier-upgrade queue
 * (`/admin/renewals/tier-upgrades`).
 *
 * The nearest ancestor boundary was `admin/error.tsx`, which would blank the
 * whole admin shell (sidebar + top nav) on a throw from this page's data load.
 * This stops the error at the page, inside the same `TableContainer` the page
 * uses so there is no layout width jump. Mirrors the portal renewal route,
 * which ships both `loading.tsx` and `error.tsx`.
 */
export default function TierUpgradesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[renewals/tier-upgrades error boundary]', error);
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

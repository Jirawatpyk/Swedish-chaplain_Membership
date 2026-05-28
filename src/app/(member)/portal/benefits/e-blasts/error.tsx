'use client';

/**
 * Route-level error boundary for /portal/benefits/e-blasts. Recoverable,
 * page-scoped error (Retry + `error.digest`) in the detail container so a throw
 * in the broadcast-history query surfaces here, not at the root portal boundary.
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
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function PortalEblastsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[portal e-blasts error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
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
    </DetailContainer>
  );
}

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
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';

/**
 * Route-level error boundary for the entire staff portal
 * (`/admin/**`). Catches runtime exceptions from server components
 * (e.g. Neon timeout in `UsersDataSection`, `PlansList`, or any future
 * data fetch) and renders a recoverable error page inside the staff
 * shell so the sidebar + top bar remain usable.
 *
 * Next.js requires this to be a Client Component — `error.tsx` must
 * expose `reset()` which only runs client-side.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    // Surface once so the user's console correlates with server logs
    // via `error.digest`.
    console.error('[admin error boundary]', error);
  }, [error]);

  return (
    <ContentContainer>
      <PageHeader title={t('generic')} />
      <Card>
        <CardHeader className="flex flex-row items-start gap-3">
          <AlertCircleIcon className="size-6 text-destructive" aria-hidden />
          <div>
            <CardTitle>{t('generic')}</CardTitle>
            <CardDescription>
              {error.digest ? `Error ID: ${error.digest}` : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={reset}>{t('retry')}</Button>
        </CardContent>
      </Card>
    </ContentContainer>
  );
}

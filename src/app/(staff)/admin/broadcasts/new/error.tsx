'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * T155 finding U10 — segment-scoped error boundary for staff
 * compose-on-behalf (`/admin/broadcasts/new`).
 *
 * The route had none, so a throw from the member lookup, the template-options
 * load or `<ProxyComposeForm />` fell through to the QUEUE's boundary
 * (`../error.tsx`): it renders `TableContainer` — the wrong container tier for
 * a form page whose `page.tsx` and `loading.tsx` both use `DetailContainer` —
 * under the title "E-Blast review queue", naming a page the operator was not
 * on. Same shape as its `templates/error.tsx` sibling: the page's own
 * container (`check:layout` pins the trio), the shared `errors.*` /
 * `buttons.retry` copy, and a route-scoped Retry.
 */
export default function BroadcastProxyComposeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  // The page's OWN title — the point of U10 is that the inherited boundary
  // named another page.
  const tProxy = useTranslations('admin.broadcasts.proxySubmitDialog');

  useEffect(() => {
    console.error('[admin/broadcasts/new error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={tProxy('title')} />
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

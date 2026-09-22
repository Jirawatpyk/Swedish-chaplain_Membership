'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * Senior-tester review H1 (US6-AS3, FR-047) — segment-scoped error boundary
 * for the new-template form (`/admin/broadcasts/templates/new`).
 *
 * The route had none, so a throw from the flag gate, the permission gate or
 * `<AdminTemplateForm mode="new" />` fell through to the template LIST's
 * boundary (`../error.tsx`): it renders `TableContainer` — the wrong container
 * tier for a form page whose `page.tsx` and `loading.tsx` both use
 * `FormContainer` — under the title "New template", naming the library rather
 * than the form the operator was filling in. Same U10 class T142 fixed one
 * level up at `/admin/broadcasts/new`.
 *
 * Shape matches its siblings: the page's OWN container and title key, the
 * shared `errors.*` / `buttons.retry` copy, and a route-scoped Retry.
 */
export default function BroadcastNewTemplateError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  const tTemplates = useTranslations('admin.broadcasts.templates');

  useEffect(() => {
    console.error('[admin/broadcasts/templates/new error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tTemplates('newPageTitle')} />
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
    </FormContainer>
  );
}

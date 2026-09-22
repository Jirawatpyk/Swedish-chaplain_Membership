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
 * for the template edit form (`/admin/broadcasts/templates/[id]/edit`).
 *
 * The route had none, so a throw from the tenant-confined `findById`, the
 * cross-tenant probe audit or `<AdminTemplateForm mode="edit" />` fell through
 * to the template LIST's boundary (`../../error.tsx`): it renders
 * `TableContainer` — the wrong container tier for a form page whose `page.tsx`
 * and `loading.tsx` both use `FormContainer` — under the library's title, on a
 * page the operator had opened to edit ONE template. Same U10 class T142 fixed
 * one level up at `/admin/broadcasts/new`.
 *
 * `notFound()` still reaches the not-found UI rather than this boundary, so a
 * cross-tenant probe keeps behaving exactly as before.
 */
export default function BroadcastEditTemplateError({
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
    console.error('[admin/broadcasts/templates/[id]/edit error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tTemplates('editPageTitle')} />
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

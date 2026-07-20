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
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * WP8 (BP5 item 7) — segment-scoped error boundary for the member-edit page
 * (`/admin/members/[memberId]/edit`).
 *
 * Without an edit-scoped boundary, a throw here bubbled to the member DETAIL
 * boundary (`[memberId]/error.tsx`, a 72rem `DetailContainer`), so the error
 * card rendered ~30rem wider than the 42rem edit form — a jarring width jump.
 * This keeps the error inside the edit form's own `FormContainer`.
 */
export default function EditMemberError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error('[members/[memberId]/edit error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
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
    </FormContainer>
  );
}

'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * WP8 (BP5 item 7) — segment-scoped error boundary for the member-edit page
 * (`/admin/members/[memberId]/edit`).
 *
 * Without an edit-scoped boundary, a throw here bubbled to the member DETAIL
 * boundary (`[memberId]/error.tsx`, a 72rem `DetailContainer`), so the error
 * card rendered ~30rem wider than the 42rem edit form — a jarring width jump.
 * This keeps the error inside the edit form's own `FormContainer`. Spec 122
 * US5b-2: the shared AURA error panel (Retry + the error id).
 */
export default function EditMemberError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    console.error('[members/[memberId]/edit error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={t('generic')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}

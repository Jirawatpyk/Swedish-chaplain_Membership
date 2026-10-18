'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

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
  const tTemplates = useTranslations('admin.broadcasts.templates');

  useEffect(() => {
    console.error('[admin/broadcasts/templates/[id]/edit error boundary]', error);
  }, [error]);

  return (
    <FormContainer align="start">
      <PageHeader title={tTemplates('editPageTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}

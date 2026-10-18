'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

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
  const tTemplates = useTranslations('admin.broadcasts.templates');

  useEffect(() => {
    console.error('[admin/broadcasts/templates/new error boundary]', error);
  }, [error]);

  return (
    <FormContainer>
      <PageHeader title={tTemplates('newPageTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </FormContainer>
  );
}

'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

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
 *
 * 122 US12d-1 (T1233): the body is the shared AURA RouteErrorPanel.
 */
export default function BroadcastProxyComposeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // The page's OWN title — the point of U10 is that the inherited boundary
  // named another page.
  const tProxy = useTranslations('admin.broadcasts.proxySubmitDialog');

  useEffect(() => {
    console.error('[admin/broadcasts/new error boundary]', error);
  }, [error]);

  return (
    <DetailContainer>
      <PageHeader title={tProxy('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </DetailContainer>
  );
}

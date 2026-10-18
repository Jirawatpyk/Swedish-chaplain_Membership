'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for the E-Blast
 * template library. A template-list read that fails THROWS from the page (it
 * must never render the "no templates yet" empty state, which would invite an
 * operator to re-author templates that already exist) and lands here with the
 * admin shell intact. Same `TableContainer` as page.tsx + loading.tsx
 * (`check:layout`).
 */
export default function BroadcastTemplatesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tTemplates = useTranslations('admin.broadcasts.templates');

  useEffect(() => {
    console.error('[admin/broadcasts/templates error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={tTemplates('pageTitle')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

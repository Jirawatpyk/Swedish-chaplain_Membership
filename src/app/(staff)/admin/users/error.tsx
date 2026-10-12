'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RouteErrorPanel } from '@/components/shell/route-error-panel';

/**
 * Spec 122 US10a (T1006) — segment-scoped error boundary for `/admin/users`.
 * A failed user read lands here instead of the app-wide boundary, keeping the
 * admin shell (sidebar + top nav) intact, with a retry. Same TableContainer
 * as page.tsx (check:layout).
 */
export default function AdminUsersError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('admin.users');

  useEffect(() => {
    console.error('[admin/users error boundary]', error);
  }, [error]);

  return (
    <TableContainer>
      <PageHeader title={t('title')} />
      <RouteErrorPanel digest={error.digest} onRetry={reset} />
    </TableContainer>
  );
}

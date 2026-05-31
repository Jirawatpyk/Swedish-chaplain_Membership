'use client';

/**
 * F9 dashboard error state (FR-006) — shown when the snapshot is genuinely
 * unavailable (compute failed), distinct from a cold/empty tenant. Wraps the
 * shared `ErrorState` with a client `router.refresh()` retry so the staff user
 * has an obvious recovery path (re-runs the server component → cold-start
 * recompute) instead of a dead-end "empty" message during a transient outage.
 */
import { useRouter } from 'next/navigation';
import { ErrorState } from '@/components/shell/error-state';

export function DashboardErrorState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  const router = useRouter();
  return <ErrorState title={title} description={description} onRetry={() => router.refresh()} />;
}

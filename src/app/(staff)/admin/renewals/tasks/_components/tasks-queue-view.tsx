/**
 * 122 US7b-2 (T735) — the escalation tasks page's body, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=renewal-tasks`), so
 * the screenshots show the page itself. Boards `Admin-renewal-tasks` (+
 * `-mobile`) and `Admin-state-tasks-manager`.
 *
 * The page keeps the data, its `TableContainer` and its `PageHeader`
 * (check:layout reads the page file); it passes the section tabs (a Suspense
 * island) and the queue as nodes.
 */
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Alert, Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { RenewalsErrorRetry } from '../../_components/renewals-error-retry';

export interface TasksQueueViewProps {
  /** Pipeline / Pending review / Tasks / Tier upgrades, with their counts. */
  readonly sectionTabs: ReactNode;
  /** The queue (`EscalationTaskQueue`), or null when the read failed. */
  readonly queue: ReactNode;
  /** The keyset "Next 50" link, or null on the last page. */
  readonly nextHref: string | null;
  /** The queue read failed: say so rather than show an empty queue. */
  readonly loadFailed?: boolean;
}

export async function renderTasksQueueView({ sectionTabs, queue, nextHref, loadFailed = false }: TasksQueueViewProps) {
  const t = await getTranslations('admin.renewals.tasks');
  return (
    // One card on a desktop; on a phone the rows are cards of their own, so it
    // drops its frame and padding, putting them on the page gutter.
    <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {sectionTabs}
        {loadFailed ? (
          <Alert
            tone="danger"
            title={t('error_state.title')}
            action={<RenewalsErrorRetry label={t('error_state.retry')} retryingLabel={t('error_state.retrying')} />}
          >
            {t('error_state.subtitle')}
          </Alert>
        ) : (
          <>
            {queue}
            {/* UX-audit PR-A #1 — the keyset footer, only when the page is
                capped at 50. A plain link (works without JavaScript); the copy
                is page-position-neutral, so it holds on page 2 too. */}
            {nextHref ? (
              <div className="flex flex-wrap items-center justify-between gap-[var(--aura-space-3)]">
                <p className="m-0 text-xs text-[var(--aura-fg-secondary)]">{t('pagination.showingFirst')}</p>
                <a href={nextHref} className={buttonClass({ variant: 'secondary' })}>
                  {t('pagination.next')}
                </a>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

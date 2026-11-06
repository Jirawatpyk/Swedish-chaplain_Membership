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
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { CursorPagination } from '@/components/layout/cursor-pagination';
import { RenewalsErrorRetry } from '../../_components/renewals-error-retry';

export interface TasksQueueViewProps {
  /** Pipeline / Pending review / Tasks / Tier upgrades, with their counts. */
  readonly sectionTabs: ReactNode;
  /** The queue (`EscalationTaskQueue`), or null when the read failed. */
  readonly queue: ReactNode;
  /** The keyset "Next 50" link, or null on the last page. */
  readonly nextHref: string | null;
  /** "First page": the cursor-less view, or null on the first page. */
  readonly firstHref?: string | null | undefined;
  /** The queue read failed: say so rather than show an empty queue. */
  readonly loadFailed?: boolean;
}

export async function renderTasksQueueView({ sectionTabs, queue, nextHref, firstHref = null, loadFailed = false }: TasksQueueViewProps) {
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
            {/* UX-audit PR-A #1 — the keyset footer, while the page is
                capped at 50 or was reached by a cursor: AURA cursor
                Pagination. Forward-only, so there is no Previous (AURA 5.84 #197 showPrevious); First
                (PR #757 review) is the way back from page 2+, disabled on
                the first page. Real links (work without JavaScript); the
                status is page-position-neutral, so it holds on page 2 too. */}
            {nextHref || firstHref ? (
              <CursorPagination
                label={t('pagination.label')}
                showFirst
                showPrevious={false}
                firstHref={firstHref ?? undefined}
                hasFirst={firstHref !== null}
                status={t('pagination.showingFirst')}
                nextHref={nextHref ?? undefined}
              />
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

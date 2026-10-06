/**
 * Spec 122 US9b-1 (T925) — the erase-by-email page's body on AURA (board
 * `Admin-events-erasure`), shared by the page and the no-DB preview route
 * (`/test-fixtures/aura-admin?view=erasure`) so the screenshots show the page
 * itself. The page keeps every read and guard; this only draws the state.
 *
 * One card holds the search panel with the count beside "Erase all" (a
 * polite status, set only after a successful search so it never collides with
 * the error alert), the truncated banner, and the result: the prompt, the
 * error, "no matches", or the results table. "Back to events" shows from
 * `lg`; below it the shell's back link does the same.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { EraseByEmailPanel } from '@/components/events/erase-by-email-panel';
import { ErasureResultsTable, type ErasureResultRow } from '@/components/events/erasure-results-table';

/** The search's result cap (`runSearchAttendeesByEmail`), named in the banner. */
const SEARCH_CAP = 500;

export interface ErasureViewState {
  /** The normalised, validated email searched for (`''` when none). */
  readonly searchedEmail: string;
  readonly status: 'idle' | 'error' | 'results';
  readonly truncated: boolean;
  readonly rows: readonly ErasureResultRow[];
}

export async function renderErasureBody({ searchedEmail, status, truncated, rows }: ErasureViewState) {
  const t = await getTranslations('admin.events.erasure');
  const searched = searchedEmail !== '' && status !== 'idle';
  const quiet = 'aura-text-body py-[var(--aura-space-8)] text-center text-[var(--aura-fg-secondary)]';

  return (
    <>
      <PageHeader title={t('pageTitle')} subtitle={t('pageHint')} />
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <EraseByEmailPanel
            email={searchedEmail}
            matchCount={status === 'results' ? rows.length : 0}
            showCount={searched && status === 'results'}
          />

          {searched && status === 'results' && truncated ? (
            <Alert tone="warning" role="alert">
              {t('truncatedBanner', { cap: SEARCH_CAP })}
            </Alert>
          ) : null}

          {!searched ? (
            <p className={quiet}>{t('emptyPrompt')}</p>
          ) : status === 'error' ? (
            <Alert tone="danger" role="alert">
              {t('errorState')}
            </Alert>
          ) : rows.length === 0 ? (
            <p className={quiet}>{t('noMatches')}</p>
          ) : (
            <ErasureResultsTable rows={rows} />
          )}

          <Link
            href="/admin/events"
            className="inline-flex items-center gap-1 self-start text-sm text-[var(--aura-fg-accent)] hover:underline max-lg:hidden"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('backLink')}
          </Link>
        </div>
      </Card>
    </>
  );
}

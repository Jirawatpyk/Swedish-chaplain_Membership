import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { InboxIcon } from 'lucide-react';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { BackLink } from '@/components/portal/back-link';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';
import { ChangeRequestStatusBadge, changeRequestStatusOf } from './change-request-status-badge';

/**
 * `/portal/change-requests` as the `Portal-change-requests` boards draw it,
 * once the page has read its page of requests (spec 122 US3). Split from the
 * page so the preview harness renders the same markup from sample data; a
 * plain async function, like `renderPortalProfileView`.
 */
export interface ChangeRequestHistoryViewProps {
  readonly items: readonly ChangeRequestView[];
  /** The opaque keyset cursor of the next page, if any. */
  readonly nextCursor: string | null;
  /** No `?cursor=`: an empty list is "no requests yet", not a page past the end. */
  readonly isFirstPage: boolean;
}

export async function renderChangeRequestHistoryView({ items, nextCursor, isFirstPage }: ChangeRequestHistoryViewProps) {
  const t = await getTranslations('portal.changeRequests.history');
  const tOutcome = await getTranslations('portal.changeRequests.outcome');
  const locale = await getLocale();
  const fmt = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });
  // The decision is a day, not a moment (the board: "decided 4 Aug 2026").
  const fmtDay = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium' });

  return (
    <DetailContainer>
      {/* The `Portal-change-requests` board: a text link back, above the title. */}
      <BackLink href="/portal/profile">{t('backToProfile')}</BackLink>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {items.length === 0 && isFirstPage ? (
        <div data-testid="history-empty">
          <EmptyState icon={InboxIcon} title={t('empty')} description={t('emptyHint')} bordered />
        </div>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="history-list" aria-label={t('listLabel')}>
          {items.map((r) => (
            <li key={r.id}>
              {/* An AURA card per request (spec 122 US3): the submission time as
                  its h2 with who and when under it, the status pill to its
                  right — above it on phones (h2 first in the DOM). The block
                  sits in AURA's free Card head (#87, 5.15), which adds no
                  heading of its own. */}
              <Card
                as="section"
                data-testid="history-item"
                data-request-id={r.id}
                aria-labelledby={`history-${r.id}-heading`}
                header={
                  <div className="flex flex-col-reverse gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {/* AURA's card-title type on the inner text: preflight resets a heading's font */}
                      <h2 id={`history-${r.id}-heading`}>
                        <span className="aura-text-h3 block">{t('submittedOn', { submittedAt: fmt(r.submittedAt) })}</span>
                      </h2>
                      <p className="aura-text-table-cell text-[var(--aura-fg-secondary)] max-sm:text-xs">
                        {r.submittedBy.isMe ? t('submittedByYou') : t('submittedBy', { name: r.submittedBy.displayName })}
                        {r.decidedAt ? ` · ${t('decidedOn', { decidedAt: fmtDay(r.decidedAt) })}` : null}
                        {r.state === 'withdrawn' && r.withdrawnAt ? ` · ${t('withdrawnOn', { withdrawnAt: fmtDay(r.withdrawnAt) })}` : null}
                      </p>
                    </div>
                    <span className="self-start">
                      <ChangeRequestStatusBadge status={changeRequestStatusOf(r)} audience="portal" />
                    </span>
                  </div>
                }
              >
                <div className="flex flex-col gap-4">
                  <ChangeRequestDiffTable fields={r.fields} showOutcome={r.state === 'decided'} variant="plain" />
                  {r.decisionReason ? (
                    <div
                      className="flex flex-col gap-0.5 rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-3.5 py-3 max-sm:px-3"
                      data-testid="history-reason"
                    >
                      <p className="text-xs font-semibold text-[var(--aura-fg-secondary)]">{tOutcome('reasonLabel')}</p>
                      <p className="whitespace-pre-wrap break-words">{r.decisionReason}</p>
                    </div>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 ? (
        // FR-029: a colleague's own-contact changes are never listed; say so.
        <p className="aura-text-table-cell text-[var(--aura-fg-secondary)]">{t('colleagueNote')}</p>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <Link href={`/portal/change-requests?cursor=${encodeURIComponent(nextCursor)}`} className={cn(buttonClass({ variant: 'secondary' }), 'max-sm:w-full')} data-testid="history-more">
            {t('loadMore')}
          </Link>
        </div>
      ) : null}
    </DetailContainer>
  );
}

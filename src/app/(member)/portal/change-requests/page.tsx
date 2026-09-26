/**
 * F114 — `/portal/change-requests` — the member's own history (US4 AS4;
 * FR-029, FR-039; T076).
 *
 * The caller's own requests + the member's company-level ones, newest first;
 * never a colleague's own-field request, and a colleague's `mixed` request
 * shows its company fields only (the list use case applies FR-029 twice —
 * SQL + projection). The reviewer is never named: `decidedBy` is the
 * organisation. Platform flag OFF → 404 (dark ship). The member is resolved
 * from the SESSION (never the URL). Paging is a server-rendered "Show older"
 * link carrying the opaque keyset cursor. A failed read throws to the
 * segment error boundary — never an empty list that says "no requests".
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { InboxIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';
import { listPortalChangeRequests } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { AuraCard, auraButtonClass } from '@/components/shell/aura-markup';
import { EmptyState } from '@/components/shell/empty-state';
import { ChangeRequestDiffTable } from '@/components/members/change-requests/change-request-diff-table';
import { ChangeRequestStatusBadge, changeRequestStatusOf } from '@/components/members/change-requests/change-request-status-badge';

const PAGE = 20;

interface PageProps {
  readonly searchParams: Promise<{ cursor?: string | string[] }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.changeRequests.history');
  return { title: t('pageTitle') };
}

export default async function PortalChangeRequestHistoryPage({ searchParams }: PageProps) {
  if (!env.features.memberChangeApproval) notFound();
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.changeRequests.history');
  const tOutcome = await getTranslations('portal.changeRequests.outcome');
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);
  const sp = await searchParams;
  const cursorRaw = Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor;

  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error({ errorId: 'M114.portal.history_page.member_read_failed', requestId, tenantId: tenant.slug, err: memberResult.error.code }, 'portal.change-requests: member lookup failed');
      throw new Error('portal.change-requests: member lookup failed');
    }
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState icon={InboxIcon} title={t('notLinked')} bordered />
      </DetailContainer>
    );
  }

  const me = asMembersUserId(user.id);
  const result = await listPortalChangeRequests(buildChangeRequestDeps(tenant), {
    userId: me,
    memberId: memberResult.value.memberId,
    cursor: cursorRaw && cursorRaw.length > 0 ? cursorRaw : null,
    limit: PAGE,
  });
  if (!result.ok) {
    // a malformed cursor is a bad link, not a fault — start from the top
    if (result.error.type === 'invalid_cursor') notFound();
    logger.error({ errorId: 'M114.portal.history_page.list_failed', requestId, tenantId: tenant.slug, err: result.error.message }, 'portal.change-requests: list failed');
    throw new Error('portal.change-requests: list failed');
  }

  const items: ChangeRequestView[] = result.value.items.map((row) =>
    serialiseChangeRequestForPortal(row.request, {
      contactId: row.request.submittedByContactId,
      displayName: row.submitter.displayName,
      isMe: row.request.submittedByUserId === me,
    }),
  );
  const fmt = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <DetailContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link href="/portal/profile" className={auraButtonClass({ variant: 'secondary' })}>
            {t('backToProfile')}
          </Link>
        }
      />
      {items.length === 0 && !cursorRaw ? (
        <div data-testid="history-empty">
          <EmptyState icon={InboxIcon} title={t('empty')} description={t('emptyHint')} bordered />
        </div>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="history-list" aria-label={t('listLabel')}>
          {items.map((r) => (
            <li key={r.id}>
              {/* An AURA card per request (spec 122 US3): the submission time as its
                  h2, who and when as its description, the status pill top-right. */}
              <AuraCard
                data-testid="history-item"
                data-request-id={r.id}
                headingLevel={2}
                titleId={`history-${r.id}-heading`}
                title={t('submittedOn', { submittedAt: fmt(r.submittedAt) })}
                description={
                  <>
                    {r.submittedBy.isMe ? t('submittedByYou') : t('submittedBy', { name: r.submittedBy.displayName })}
                    {r.decidedAt ? ` · ${t('decidedOn', { decidedAt: fmt(r.decidedAt) })}` : null}
                  </>
                }
                actions={<ChangeRequestStatusBadge status={changeRequestStatusOf(r)} audience="portal" />}
              >
                <div className="space-y-3">
                  <ChangeRequestDiffTable fields={r.fields} showOutcome={r.state === 'decided'} />
                  {r.decisionReason ? (
                    <div
                      className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-3 text-sm"
                      data-testid="history-reason"
                    >
                      <p className="font-medium">{tOutcome('reasonLabel')}</p>
                      <p className="whitespace-pre-wrap break-words">{r.decisionReason}</p>
                    </div>
                  ) : null}
                </div>
              </AuraCard>
            </li>
          ))}
        </ul>
      )}
      {result.value.nextCursor ? (
        <div className="flex justify-center">
          <Link href={`/portal/change-requests?cursor=${encodeURIComponent(result.value.nextCursor)}`} className={auraButtonClass({ variant: 'secondary' })} data-testid="history-more">
            {t('loadMore')}
          </Link>
        </div>
      ) : null}
    </DetailContainer>
  );
}

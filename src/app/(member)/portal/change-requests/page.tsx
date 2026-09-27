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
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { InboxIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';
import { listPortalChangeRequests } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { renderChangeRequestHistoryView } from '@/components/members/change-requests/change-request-history-view';

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
  return renderChangeRequestHistoryView({
    items,
    nextCursor: result.value.nextCursor ?? null,
    isFirstPage: !cursorRaw,
  });
}

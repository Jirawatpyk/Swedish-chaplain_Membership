/**
 * F9 US3 — /admin/members/[memberId]/timeline.
 *
 * Server component — queries the first page of the unified multi-source
 * timeline (`member_timeline_v`) for this member, applying the URL filters
 * (source / actorKind / date range, FR-015), redacts payload for member-role
 * users (via the use case), then hands the initial payload to the virtualized
 * client stream + the filter bar.
 *
 * FR-016 (keyset pagination), FR-017 (role redaction), FR-037 (page title).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { env } from '@/lib/env';
import { isYmd } from '@/lib/tenant-day-range';
import { asTimelineSource, asTimelineActorKind } from '@/lib/timeline-shared';
import { buildTimelineFilterInput, timelineFilterKey } from '@/lib/timeline-filter-input';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { getMember, timelineList, type MemberId } from '@/modules/members';
import { recordStaffTimelineView } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TimelineFilters } from '@/components/members/timeline-filters';
import { TimelineStream } from '@/components/members/timeline-stream';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SearchParams {
  readonly source?: string;
  readonly actorKind?: string;
  readonly from?: string;
  readonly to?: string;
}

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
  readonly searchParams: Promise<SearchParams>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.members.timeline');
  return { title: t('title') };
}

export default async function MemberTimelinePage({ params, searchParams }: PageProps) {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const session = await requireSession('staff');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);

  const t = await getTranslations('admin.members.timeline');
  const tPage = await getTranslations('timeline.page');
  const tDetail = await getTranslations('admin.members.detail');

  const deps = buildMembersDeps(tenant);
  const memberResult = await getMember(
    memberId as MemberId,
    { actorUserId: session.user.id, requestId },
    deps,
  );

  if (!memberResult.ok) {
    if (memberResult.error.type === 'not_found') {
      return (
        <DetailContainer>
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <h2 className="text-h2 text-xl font-semibold">
                {tDetail('notFound.title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {tDetail('notFound.description')}
              </p>
              <Link
                href="/admin/members"
                className={buttonVariants({ variant: 'outline' })}
              >
                <ArrowLeftIcon className="size-4" />
                {tDetail('notFound.cta')}
              </Link>
            </CardContent>
          </Card>
        </DetailContainer>
      );
    }
    throw new Error(`getMember failed: ${memberResult.error.message}`);
  }

  const { member } = memberResult.value;

  // Resolve URL filters → use-case input (UTC bounds via tenant tz).
  const sp = await searchParams;
  const tz = env.tenant.timezone;
  const filterArgs = {
    source: asTimelineSource(sp.source),
    actorKind: asTimelineActorKind(sp.actorKind),
    fromYmd: sp.from && isYmd(sp.from) ? sp.from : undefined,
    toYmd: sp.to && isYmd(sp.to) ? sp.to : undefined,
  };
  const hasFilter = Boolean(
    filterArgs.source || filterArgs.actorKind || filterArgs.fromYmd || filterArgs.toYmd,
  );

  const timelineResult = await timelineList(
    { memberId, limit: 50, ...buildTimelineFilterInput(filterArgs, tz) },
    {
      actorUserId: session.user.id,
      actorRole: session.user.role as 'admin' | 'manager' | 'member',
      requestId,
    },
    tenant,
    { memberRepo: deps.memberRepo, timeline: deps.timeline },
  );

  const initialEvents: TimelineItemProps[] = timelineResult.ok
    ? timelineResult.value.events.map(toTimelineItemProps)
    : [];
  const initialCursor = timelineResult.ok ? timelineResult.value.nextCursor : null;
  const totalEvents = timelineResult.ok ? timelineResult.value.total : 0;

  // FR-036 PII-read trail (R002): a staff member viewing another member's full
  // timeline is a third-party PII access — audit it. requireSession('staff')
  // admits only admin + manager; validate rather than cast. Best-effort.
  //
  // Scope decision (staff-review R2): ONE emit per full-timeline-page view —
  // the deliberate "show me everything" access. Consistent with
  // member_benefit_viewed's one-emit-per-page model: the load-more API
  // (/api/members/[id]/timeline) and the 3-row preview snippet on the member
  // detail page do NOT re-emit (avoids audit-log inflation; the page-view event
  // already establishes who accessed whose timeline).
  if (session.user.role === 'admin' || session.user.role === 'manager') {
    await recordStaffTimelineView({
      tenantId: tenant.slug,
      requestId,
      actorUserId: session.user.id,
      actorRole: session.user.role,
      subjectMemberId: member.memberId,
      filterApplied: hasFilter,
    });
  }

  // Remount the stream on filter change so paginated state resets cleanly.
  const filterKey = timelineFilterKey(filterArgs);

  return (
    <DetailContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href={`/admin/members/${member.memberId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            <ArrowLeftIcon className="size-4" />
            {t('backToDetail')}
          </Link>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <CardTitle className="text-base">{member.companyName}</CardTitle>
          {totalEvents > 0 && (
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {t('totalEvents', { count: totalEvents })}
            </span>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TimelineFilters />
          <TimelineStream
            key={filterKey}
            fetchPath={`/api/members/${member.memberId}/timeline`}
            initialEvents={initialEvents}
            initialCursor={initialCursor}
            emptyLabel={hasFilter ? tPage('emptyFiltered') : tPage('empty')}
            listLabel={t('title')}
          />
        </CardContent>
      </Card>
    </DetailContainer>
  );
}

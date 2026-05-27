/**
 * F9 US3 (T057) — /portal/timeline (member self-service own timeline).
 *
 * The member sees their OWN unified multi-source timeline with internal
 * annotations redacted (FR-017). The member is resolved from the session
 * (`findByLinkedUserId`) — never from the URL — so a member can only ever
 * see their own history. Load-more goes through `/api/portal/timeline`.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { env } from '@/lib/env';
import { isYmd, tenantDayStartUtc, tenantDayEndUtc } from '@/lib/tenant-day-range';
import { asTimelineSource, asTimelineActorKind } from '@/lib/timeline-shared';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { TimelineFilters } from '@/components/members/timeline-filters';
import { TimelineStream } from '@/components/members/timeline-stream';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

interface SearchParams {
  readonly source?: string;
  readonly actorKind?: string;
  readonly from?: string;
  readonly to?: string;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('timeline.page');
  return { title: t('title') };
}

export default async function PortalTimelinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireSession('member');
  const t = await getTranslations('timeline.page');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);

  const deps = buildMembersDeps(tenant);
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }
  const member = memberResult.value;

  const sp = await searchParams;
  const tz = env.tenant.timezone;
  const source = asTimelineSource(sp.source);
  const actorKind = asTimelineActorKind(sp.actorKind);
  const fromYmd = sp.from && isYmd(sp.from) ? sp.from : undefined;
  const toYmd = sp.to && isYmd(sp.to) ? sp.to : undefined;
  const hasFilter = Boolean(source || actorKind || fromYmd || toYmd);

  const result = await timelineList(
    {
      memberId: member.memberId,
      limit: 50,
      ...(source ? { source } : {}),
      ...(actorKind ? { actorKind } : {}),
      ...(fromYmd ? { from: tenantDayStartUtc(fromYmd, tz) } : {}),
      ...(toYmd ? { to: tenantDayEndUtc(toYmd, tz) } : {}),
    },
    { actorUserId: user.id, actorRole: 'member', requestId },
    tenant,
    { memberRepo: deps.memberRepo, timeline: deps.timeline },
  );

  const initialEvents: TimelineItemProps[] = result.ok
    ? result.value.events.map(toTimelineItemProps)
    : [];
  const initialCursor = result.ok ? result.value.nextCursor : null;
  const filterKey = `${source ?? ''}|${actorKind ?? ''}|${fromYmd ?? ''}|${toYmd ?? ''}`;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <TimelineFilters />
          <TimelineStream
            key={filterKey}
            fetchPath="/api/portal/timeline"
            initialEvents={initialEvents}
            initialCursor={initialCursor}
            emptyLabel={hasFilter ? t('emptyFiltered') : t('empty')}
            listLabel={t('title')}
          />
        </CardContent>
      </Card>
    </DetailContainer>
  );
}

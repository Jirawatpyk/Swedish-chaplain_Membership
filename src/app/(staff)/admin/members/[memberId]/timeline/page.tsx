/**
 * T132 — /admin/members/[memberId]/timeline (US6).
 *
 * Server component — queries the first page of audit events for this
 * member, redacts payload for member-role users (via the use case),
 * then hands the initial payload to a Client wrapper that provides
 * the "Load more" button.
 *
 * Follows FR-020 (paginated, newest-first), FR-023 (reads audit_log),
 * FR-024 (WCAG 2.1 AA — keyboard reachable, aria-live, reduced motion),
 * FR-037 (unique page title via generateMetadata).
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
import { getMember, timelineList } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { DetailContainer } from '@/components/layout/detail-container';
import { PageHeader } from '@/components/layout/page-header';
import { TimelineClient } from '@/components/members/timeline-client';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) return { title: 'Timeline · SweCham' };
  return { title: 'Timeline · SweCham' };
}

export default async function MemberTimelinePage({ params }: PageProps) {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const session = await requireSession('staff');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);

  const t = await getTranslations('admin.members.timeline');
  const tDetail = await getTranslations('admin.members.detail');

  // 1. Fetch member metadata so we can show the company name in the header
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

  // 2. Load first page of timeline events
  const timelineResult = await timelineList(
    { memberId, limit: 50 },
    {
      actorUserId: session.user.id,
      actorRole: session.user.role as 'admin' | 'manager' | 'member',
      requestId,
    },
    tenant,
    {
      memberRepo: deps.memberRepo,
      timeline: deps.timeline,
    },
  );

  const initialEvents: TimelineItemProps[] = timelineResult.ok
    ? timelineResult.value.events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp.toISOString(),
        eventType: e.eventType,
        actorUserId: e.actorUserId,
        actorDisplayName: e.actorDisplayName,
        payload: e.payload,
      }))
    : [];
  const initialCursor = timelineResult.ok
    ? timelineResult.value.nextCursor
    : null;
  const totalEvents = timelineResult.ok ? timelineResult.value.total : 0;

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
        <CardContent>
          <TimelineClient
            memberId={member.memberId}
            initialEvents={initialEvents}
            initialCursor={initialCursor}
          />
        </CardContent>
      </Card>
    </DetailContainer>
  );
}

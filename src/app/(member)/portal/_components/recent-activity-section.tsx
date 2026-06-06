import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { ClockIcon } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RecentActivityList } from './recent-activity-list';

/**
 * 057 portal redesign §4.1 — Recent activity preview section.
 *
 * Server component: resolves the first 4 timeline events with member-role
 * permission filter (spec S-2 — redacts internal annotations), then passes
 * the already-shaped `TimelineItemProps[]` to the client `RecentActivityList`
 * for rendering. Separating the data fetch (server) from the item display
 * (client, needs `useTranslations`) keeps this file RSC-compatible.
 *
 * `memberId` comes from the session (`findByLinkedUserId`), never the URL —
 * a member can only see their own activity (Constitution Principle I).
 */

const PREVIEW_LIMIT = 4;

export async function RecentActivitySection({
  userId,
  memberId,
}: {
  readonly userId: string;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.activity');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);
  const deps = buildMembersDeps(tenant);

  const result = await timelineList(
    { memberId, limit: PREVIEW_LIMIT },
    { actorUserId: userId, actorRole: 'member', requestId },
    tenant,
    { memberRepo: deps.memberRepo, timeline: deps.timeline },
  );

  // D1 review finding B2 — a failed read must NOT fall open to the "No activity
  // yet" empty state (which tells a member nothing happened when in fact the
  // read failed). Distinguish the failure: log it here in the SERVER component
  // (errKind only — never raw error/PII) and render a distinct "unavailable"
  // state below. The log stays server-side; the client `RecentActivityList`
  // never sees the error.
  if (!result.ok) {
    logger.warn(
      { requestId, errKind: errKind(rootCause(result.error)) },
      '[dashboard-recent-activity] timelineList failed',
    );
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <h2 className="font-heading text-base font-medium leading-snug">{t('title')}</h2>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">{t('loadFailed')}</p>
        </CardContent>
      </Card>
    );
  }

  const events = result.value.events
    .slice(0, PREVIEW_LIMIT)
    .map(toTimelineItemProps);

  return (
    <Card>
      {/* Header matches the admin timeline-preview pattern for app-wide
          consistency: heading + an outline "view all" link at the project's
          DEFAULT button size. (The earlier `ghost size=sm min-h-11` 44px link
          was oversized for a one-line header — it inflated the header row and
          pushed the content down; the admin convention is `variant:'outline'`
          default size, ~h-9.) */}
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium leading-snug">{t('title')}</h2>
        {events.length > 0 ? (
          <Link href="/portal/timeline" className={buttonVariants({ variant: 'outline' })}>
            <ClockIcon className="size-4" />
            {t('viewAll')}
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            {/* activity.empty.title = "No activity yet" (nested key, existing G2 key) */}
            <p className="text-sm text-muted-foreground">{t('empty.title')}</p>
            <Link
              href="/portal/benefits"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-11 px-3')}
            >
              {t('emptyCta')}
            </Link>
          </div>
        ) : (
          <RecentActivityList events={events} />
        )}
      </CardContent>
    </Card>
  );
}

export function RecentActivitySkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

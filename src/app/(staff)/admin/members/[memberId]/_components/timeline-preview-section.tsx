/**
 * I7 round-10 ui-design-specialist — inline timeline preview on the
 * member detail page. Shows the 3 most recent audit events so admins
 * doing a daily "what happened to this member" check don't have to
 * round-trip through /timeline. The full "View all activity" CTA
 * stays as the action-row link in the page header.
 *
 * Server component. Wrapped in a Suspense boundary at the call site
 * with `TimelinePreviewSkeleton` as fallback — keeps the parent
 * member-detail render uncoupled from this fetch (CLS-stable).
 *
 * Audit-side semantics:
 *   - admin → full payload; the timeline-list use-case applies role
 *     redaction internally (override reasons + notes stripped for
 *     non-admins).
 *   - manager / member → redacted payload via timeline-list's role
 *     projection.
 *   - empty timeline → renders an "No recent activity yet" microcopy
 *     so the section doesn't ghost.
 *
 * Errors are caught + logged + downgraded to the empty-state render
 * so a timeline-fetch failure cannot crash the detail page.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { ClockIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { TimelineEventItem } from '@/components/members/timeline-event-item';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

const PREVIEW_LIMIT = 3;

interface Props {
  readonly memberId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager' | 'member';
}

export async function TimelinePreviewSection({
  memberId,
  actorUserId,
  actorRole,
}: Props) {
  const t = await getTranslations('admin.members.detail');
  const tTimeline = await getTranslations('admin.members.timeline');

  const h = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: h });
  const tenant = resolveTenantFromRequest(pseudoReq as never);
  const requestId = requestIdFromHeaders(h);
  const deps = buildMembersDeps(tenant);

  // Compose the timeline events under a try/catch so any infra failure
  // surfaces as the empty-state copy rather than crashing the parent.
  let events: TimelineItemProps[] = [];
  try {
    const result = await timelineList(
      { memberId, limit: PREVIEW_LIMIT },
      { actorUserId, actorRole, requestId },
      tenant,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    if (result.ok) {
      events = result.value.events.map(toTimelineItemProps);
    } else {
      logger.error(
        { event: 'timeline_preview_use_case_err', err: result.error, memberId },
        '[F3] timeline preview — use-case returned err',
      );
    }
  } catch (e) {
    logger.error(
      {
        event: 'timeline_preview_threw',
        err: e instanceof Error ? e.message : String(e),
        memberId,
      },
      '[F3] timeline preview — fetch threw',
    );
  }

  return (
    <section aria-labelledby="member-timeline-preview-heading">
      <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        {/* 056 fix #1 — real <h2> so the timeline section is reachable via
            SR heading navigation under the page <h1>. */}
        <h2
          id="member-timeline-preview-heading"
          className="font-heading text-base font-medium leading-snug"
        >
          {t('sections.audit')}
        </h2>
        <Link
          href={`/admin/members/${memberId}/timeline`}
          className={buttonVariants({ variant: 'outline' })}
        >
          <ClockIcon className="size-4" />
          {t('timelinePreview.viewAll')}
        </Link>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('timelinePreview.empty')}
            </p>
          </div>
        ) : (
          <ul
            className="flex flex-col gap-1"
            aria-label={tTimeline('subtitle')}
          >
            {events.map((ev) => (
              <li key={ev.id}>
                <TimelineEventItem {...ev} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      </Card>
    </section>
  );
}

/**
 * Skeleton matching the 3-row timeline shape — used as the Suspense
 * fallback at the call site for CLS-stable layout.
 *
 * H4: replaced raw `animate-pulse` divs with the canonical <Skeleton>
 * component which has shimmer + reduced-motion support built in via
 * `skeleton-shimmer` CSS class (defined in globals.css).
 */
export function TimelinePreviewSkeleton() {
  return (
    <Card aria-busy="true" aria-hidden="true">
      <CardHeader className="flex flex-row items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-9 w-28" />
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {Array.from({ length: PREVIEW_LIMIT }).map((_, i) => (
            <li
              key={i}
              className="relative border-l-2 border-muted pl-6 py-3"
            >
              {/* Matches the real TimelineEventItem marker (24px circle at
                  -left-[13px]) so the skeleton→content swap is CLS-free. */}
              <span className="absolute -left-[13px] top-4 size-6 rounded-full border bg-background" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

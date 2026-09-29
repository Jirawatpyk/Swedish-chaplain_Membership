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
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { requirePagePermission, canPerform } from '@/lib/rbac';
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
import type { TimelineItemProps } from '@/components/members/timeline-event-item';
import { MemberNotFound } from '../_components/member-not-found';
import { renderMemberTimelineView } from '../_components/member-timeline-view';

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

  const session = await requirePagePermission('members.read');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);


  const deps = buildMembersDeps(tenant);
  const memberResult = await getMember(
    memberId as MemberId,
    { actorUserId: session.user.id, requestId },
    deps,
  );

  if (!memberResult.ok) {
    if (memberResult.error.type === 'not_found') {
      return <MemberNotFound />;
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
      actorRole: session.user.role,
      requestId,
    },
    tenant,
    {
      memberRepo: deps.memberRepo,
      timeline: deps.timeline,
      // rbac-subgate-ok: gates the money ROWS of an already-authorised
      // response; admission is the page guard above. 016 final review B2 —
      // this SSR path was missed when the gate landed, so a super_admin's
      // first page showed no invoices while the API-driven "load more" did.
      viewerContactId: null, // staff viewer — the FR-029 projection is member-only
      invoicingRead: canPerform(
        session.user.role,
        'invoicing.read',
      ),
    },
  );

  const initialEvents: TimelineItemProps[] = timelineResult.ok
    ? timelineResult.value.events.map(toTimelineItemProps)
    : [];
  const initialCursor = timelineResult.ok ? timelineResult.value.nextCursor : null;
  const totalEvents = timelineResult.ok ? timelineResult.value.total : 0;

  // FR-036 PII-read trail (R002): a staff member viewing another member's full
  // timeline is a third-party PII access — audit it. The gate is
  // `requirePagePermission('members.read', …)` above; the trail records the
  // actor's REAL role rather than coercing it. Best-effort.
  //
  // Scope decision (staff-review R2): ONE emit per full-timeline-page view —
  // the deliberate "show me everything" access. Consistent with
  // member_benefit_viewed's one-emit-per-page model: the load-more API
  // (/api/members/[id]/timeline) and the 3-row preview snippet on the member
  // detail page do NOT re-emit (avoids audit-log inflation; the page-view event
  // already establishes who accessed whose timeline).
  // 016 re-review D — emit UNCONDITIONALLY: the page gate above only admits
  // staff, so every viewer here is a third-party PII access worth a trail.
  // The old `admin || manager` pair meant a promoted super_admin's (or PR-4
  // marketing's) full-timeline view would have gone UNRECORDED — an audit gap,
  // the opposite failure mode from the affordance literals. actorRole takes
  // the literal role (T033 widened it).
  {
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

  return renderMemberTimelineView({
    member: { memberId: member.memberId, companyName: member.companyName },
    initialEvents,
    initialCursor,
    totalEvents,
    hasFilter,
    filterKey,
  });
}

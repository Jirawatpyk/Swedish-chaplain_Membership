import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveOwnContactId } from '@/lib/portal-own-contact';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { asMemberId, timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { ArrowRight } from 'lucide-react';
import { AuraCard, auraButtonClass } from '@/components/shell/aura-markup';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
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

  // F114 (privacy I-1, round 7) — resolved BEFORE the list read; a fault
  // renders the same "unavailable" card as a failed list read (B2), never a
  // preview that silently omits the viewer's own change requests
  const ownContact = await resolveOwnContactId(deps.contactRepo, tenant, asMemberId(memberId), userId, requestId);
  if (!ownContact.ok) {
    logger.warn({ requestId, errKind: ownContact.error.code }, '[dashboard-recent-activity] own contact unresolved');
    return unavailableCard(t('title'), t('loadFailed'));
  }
  const result = await timelineList(
    { memberId, limit: PREVIEW_LIMIT },
    { actorUserId: userId, actorRole: 'member', requestId },
    tenant,
    {
      memberRepo: deps.memberRepo,
      timeline: deps.timeline,
      // F114 (privacy I-1, round 2 R-2) — the viewer's OWN contact so their
      // own change requests show while a colleague's own-field ones do not
      viewerContactId: ownContact.value,
      // 016 final review B2 — the member OWNS this billing history. The gate
      // exists to stop STAFF without `invoicing.read` reading someone else's;
      // omitting it here hid the member's own invoices from page 1 while the
      // API path still returned them.
      invoicingRead: true,
    },
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
    return unavailableCard(t('title'), t('loadFailed'));
  }

  const events = result.value.events
    .slice(0, PREVIEW_LIMIT)
    .map(toTimelineItemProps);

  return (
    // AURA card (spec 122 US3, `Main` board): the "view all" link sits in the
    // footer as a text link, as the board draws it.
    <AuraCard
      title={t('title')}
      headingLevel={2}
      footer={
        events.length > 0 ? (
          <Link href="/portal/timeline" className={VIEW_ALL_LINK}>
            {t('viewAll')}
            <ArrowRight size={16} className="aura-icon" aria-hidden="true" />
          </Link>
        ) : undefined
      }
    >
      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          {/* activity.empty.title = "No activity yet" (nested key, existing G2 key) */}
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('empty.title')}</p>
          <Link href="/portal/benefits" className={auraButtonClass({ variant: 'secondary' })}>
            {t('emptyCta')}
          </Link>
        </div>
      ) : (
        <RecentActivityList events={events} />
      )}
    </AuraCard>
  );
}

/** A footer text link with a 44px target, in AURA's link colour. */
const VIEW_ALL_LINK =
  'inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline';

export function RecentActivitySkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-hidden="true" className="aura-card">
      <div className="aura-card__head">
        <SkeletonBlock className="h-5 w-40" />
      </div>
      <div className="aura-card__body flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

/** The B2 "unavailable" state — one card for a failed list read and for an unresolved viewer contact. */
function unavailableCard(title: string, body: string) {
  return (
    <AuraCard title={title} headingLevel={2}>
      <p className="py-8 text-center text-sm text-[var(--aura-fg-secondary)]">{body}</p>
    </AuraCard>
  );
}

'use client';

/**
 * Pass A · Section 1 — Renewal & Health card (presentational, client-safe).
 *
 * Fed plain serializable props by the async server wrapper
 * (`MemberRenewalHealthSection`). Surfaces the member's renewal cycle status
 * and the F9 engagement score, with the renew action and the way to the
 * cycle. Layout B (maintainer, 22 Oct): the expiry, the days left and the
 * engagement band are the figures strip's, above it on the same page, so
 * the card no longer repeats them.
 *
 * Accessibility (FR-035 / WCAG 1.4.1): the cycle status is a visible TEXT
 * label, never colour alone.
 */
import Link from 'next/link';
import { ArrowRightIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Card, StatusPill } from '@jirawatpyk/aura-react';
import type { CycleStatus } from '@/modules/renewals/client';
import { CYCLE_STATUS_TONE } from '@/components/renewals/cycle-status-tone';
import type { EngagementBand } from '@/modules/insights';
import { RenewLapsedMemberDialog } from '@/components/members/renew-lapsed-member-dialog';

export interface RenewalHealthCardProps {
  /**
   * 056 fix #1 — id wired to the wrapping `<section aria-labelledby>` so the
   * card title is a real `<h2>` in the heading tree (SR heading-nav).
   */
  readonly headingId: string;
  /** Cycle status, or null when the member has no renewal cycle. */
  readonly status: CycleStatus | null;
  /** F9 engagement score 0–100 (null when un-scored OR F9 flag off). */
  readonly engagementScore: number | null;
  readonly engagementBand: EngagementBand | null;
  /** Deep link to the renewals dashboard (or the specific cycle). */
  readonly viewHref: string;
  /**
   * Cluster 7 (G18) — true when the renewal read errored. Renders a distinct
   * "unavailable" state instead of the empty state, and suppresses the
   * lapsed-comeback action: `status` is null only because the read failed, so
   * we do NOT know the true status and offering the action would be
   * misleading / could 409. Defaults false.
   */
  readonly readFailed?: boolean;
  /**
   * F8-completion Slice 3 — admin-only "Renew / reactivate this member"
   * action. The trigger is rendered ONLY when `canRenew` (admin role) AND
   * the member is lapsed (no active cycle: status ∈ lapsed | cancelled |
   * completed | null). Managers never receive `canRenew=true`, so they
   * never see the affordance (no broken button). Omitted on surfaces that
   * don't supply the member id (the dialog needs it).
   */
  readonly canRenew?: boolean;
  /** Member id for the renew POST (required when `canRenew` is true). */
  readonly memberId?: string;
}

/**
 * A member has NO active renewal cycle when its most-recent cycle is in a
 * terminal/absent state. Only then is the admin lapsed-comeback action
 * meaningful (the use-case would 409 `member_has_active_cycle` otherwise).
 */
function isLapsed(status: CycleStatus | null): boolean {
  return (
    status === null ||
    status === 'lapsed' ||
    status === 'cancelled' ||
    status === 'completed'
  );
}

export function RenewalHealthCard({
  headingId,
  status,
  engagementScore,
  engagementBand,
  viewHref,
  readFailed = false,
  canRenew = false,
  memberId,
}: RenewalHealthCardProps): React.ReactElement {
  const t = useTranslations('admin.members.detail.renewalHealth');
  const format = useFormatter();

  // The band is the strip's; the score (out of 100) is the card's own.
  const engagementValue =
    engagementScore !== null && engagementBand !== null ? (
      <span className="text-sm tabular-nums">{t('engagementScoreValue', { score: format.number(engagementScore) })}</span>
    ) : null;

  // Layout B — an AURA Card in the page's aside: Status and the engagement
  // score side by side, then Renew (lapsed only) and "View renewal →".
  return (
    <Card
      as="section"
      className="h-full"
      title={t('title')}
      titleId={headingId}
      headingLevel={2}
    >
      {/* The head holds the title alone (board `Admin-member-detail`); Renew
          and "View renewal →" close the body. AURA's card head does not wrap,
          so actions there squeeze the title on a phone (UX review M11). */}
      {readFailed ? (
        // Cluster 7 (G18) — the read errored: a DISTINCT "unavailable" state,
        // never the empty state. The engagement score is read independently,
        // so it still shows if it loaded.
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('readFailed')}</p>
          {engagementValue && (
            <dl className="flex flex-col gap-1">
              <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('engagement')}</dt>
              <dd>{engagementValue}</dd>
            </dl>
          )}
        </div>
      ) : status === null ? (
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('empty')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('status')}</dt>
            <dd>
              <StatusPill tone={CYCLE_STATUS_TONE[status]}>{t(`cycleStatus.${status}`)}</StatusPill>
            </dd>
          </div>
          {engagementValue && (
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('engagement')}</dt>
              <dd>{engagementValue}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canRenew && memberId !== undefined && !readFailed && isLapsed(status) && (
          <RenewLapsedMemberDialog memberId={memberId} />
        )}
        <Link
          href={viewHref}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
        >
          {t('viewRenewal')}
          <ArrowRightIcon className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

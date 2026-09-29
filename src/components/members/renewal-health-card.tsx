'use client';

/**
 * Pass A · Section 1 — Renewal & Health card (presentational, client-safe).
 *
 * Fed plain serializable props by the async server wrapper
 * (`MemberRenewalHealthSection`). Surfaces the member's current renewal
 * posture (status + expiry + days remaining) AND the F9 engagement score so
 * an admin on a renewal call never has to leave for `/admin/renewals` to
 * answer "is this member renewing, and how healthy are they?".
 *
 * Accessibility (FR-035 / WCAG 1.4.1): the cycle status and the engagement
 * band are rendered as visible TEXT labels, never colour-alone. The Badge
 * variant is decorative; the localised label carries the meaning.
 *
 * Localisation: the expiry date is formatted via `formatDatePreset` (en-GB for English)
 * so th-TH renders Buddhist-Era years (display-only) — the prop is an ISO
 * 8601 UTC string, never a pre-formatted/raw `.toISOString()` slice.
 */
import Link from 'next/link';
import { ArrowRightIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Badge, Card, StatusPill, buttonClass } from '@jirawatpyk/aura-react';
import type { CycleStatus } from '@/modules/renewals/client';
import type { EngagementBand } from '@/modules/insights';
import { RenewLapsedMemberDialog } from '@/components/members/renew-lapsed-member-dialog';
import { formatDatePreset } from '@/lib/format-date-localised';

export interface RenewalHealthCardProps {
  /**
   * 056 fix #1 — id wired to the wrapping `<section aria-labelledby>` so the
   * card title is a real `<h2>` in the heading tree (SR heading-nav).
   */
  readonly headingId: string;
  /** Cycle status, or null when the member has no renewal cycle. */
  readonly status: CycleStatus | null;
  /** ISO 8601 UTC expiry instant, or null. Localised at render time. */
  readonly expiryIso: string | null;
  /** Days to expiry (negative = overdue), or null when no cycle. */
  readonly daysRemaining: number | null;
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

/** Pill tone per cycle status (the word carries the meaning, not the colour). */
const STATUS_TONE: Readonly<Record<CycleStatus, 'neutral' | 'progress' | 'ready' | 'warning' | 'blocked'>> = {
  upcoming: 'neutral',
  reminded: 'neutral',
  awaiting_payment: 'progress',
  pending_admin_reactivation: 'warning',
  completed: 'ready',
  lapsed: 'blocked',
  cancelled: 'blocked',
};

/** Engagement band tones, as the members list draws them. */
const ENGAGEMENT_TONE: Readonly<Record<EngagementBand, 'success' | 'neutral' | 'warning' | 'danger'>> = {
  healthy: 'success',
  moderate: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

export function RenewalHealthCard({
  headingId,
  status,
  expiryIso,
  daysRemaining,
  engagementScore,
  engagementBand,
  viewHref,
  readFailed = false,
  canRenew = false,
  memberId,
}: RenewalHealthCardProps): React.ReactElement {
  const t = useTranslations('admin.members.detail.renewalHealth');
  const tBand = useTranslations('admin.members.directory.engagementBand');
  const format = useFormatter();
  const locale = useLocale();

  const hasEngagement = engagementScore !== null && engagementBand !== null;

  const engagementValue = hasEngagement ? (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={ENGAGEMENT_TONE[engagementBand]}>{tBand(engagementBand)}</Badge>
      <span className="text-xs tabular-nums text-[var(--aura-fg-secondary)]">{format.number(engagementScore)}</span>
    </span>
  ) : null;

  // Spec 122 US5b-1 — an AURA Card as the `Admin-member-detail` board draws
  // it: the title with "View renewal" beside it, then Status / Expiry /
  // Engagement as a list, and Renew (lapsed only) under them.
  return (
    <Card
      as="section"
      className="h-full"
      title={t('title')}
      titleId={headingId}
      headingLevel={2}
      actions={
        <Link href={viewHref} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          {t('viewRenewal')}
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
      }
    >
      {/* Renew sits in the body, not the head: AURA's card head does not wrap,
          and two actions there squeeze the title on a phone (UX review M11). */}
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
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('status')}</dt>
            <dd>
              <StatusPill tone={STATUS_TONE[status]}>{t(`cycleStatus.${status}`)}</StatusPill>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('expiry')}</dt>
            <dd className="text-sm">
              {expiryIso !== null ? (
                <span className="flex flex-col">
                  <span>{formatDatePreset(expiryIso, locale, 'dateMedium2Digit')}</span>
                  {daysRemaining !== null && (
                    <span className="text-xs text-[var(--aura-fg-secondary)]">
                      {daysRemaining < 0
                        ? t('overdueDays', { days: Math.abs(daysRemaining) })
                        : t('daysRemaining', { days: daysRemaining })}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-[var(--aura-fg-secondary)]">—</span>
              )}
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
      {canRenew && memberId !== undefined && !readFailed && isLapsed(status) && (
        <div className="mt-4">
          <RenewLapsedMemberDialog memberId={memberId} />
        </div>
      )}
    </Card>
  );
}

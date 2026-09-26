'use client';

/**
 * F9 US4 (T067 / FR-019–FR-022) — benefit consumption-vs-entitlement card.
 *
 * Presentational + client-safe: imports only UI primitives + local prop types
 * (no `@/modules/insights` import, so the server source-reader graph never
 * leaks into the client bundle — the US3 lesson). The server page maps the
 * `BenefitUsage` VO onto these plain serialisable props.
 *
 * - Quantifiable benefits render as labelled <ProgressBar>s (used / entitlement)
 *   with a last-used date + an optional deep-link action (AS-1).
 * - Unlimited / active-only benefits render as badges, not quotas (FR-020/AS-3).
 * - The under-use warning renders above the bars when flagged (FR-021).
 * - Staff-only actions (send reminder / suggest usage) slot in via `staffActions`
 *   so the same card serves the member + admin variants (FR-022/AS-4).
 * - `staffSubjectName` switches the under-use warning to third-person staff
 *   copy; the member portal keeps the second-person wording.
 */
import Link from 'next/link';
import { ArrowRight, PackageOpen, PauseCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCalendarYear, getDateFormatLocale } from '@/lib/format-date-localised';
import { Badge, Progress, Separator } from '@jirawatpyk/aura-react';
import { AuraCard } from '@/components/shell/aura-markup';
import { UnderUseWarning } from './under-use-warning';

export interface BenefitUsageItem {
  readonly key: 'eblast' | 'cultural_tickets';
  readonly used: number;
  readonly entitlement: number;
  /** ISO 8601 UTC, or null when unused this year. */
  readonly lastUsedAt: string | null;
  /** Optional deep link to act on this benefit (e.g. compose an E-Blast). */
  readonly actionHref?: string;
}

export interface BenefitUsageCardProps {
  /** BCP-47 locale for date formatting (number formatting stays localized via ICU). */
  readonly locale: string;
  readonly membershipYear: number;
  readonly elapsedYearPct: number;
  readonly quantifiable: ReadonlyArray<BenefitUsageItem>;
  readonly active: ReadonlyArray<{ readonly key: string }>;
  readonly aggregateConsumedPct: number | null;
  readonly underUseWarning: boolean;
  /** Deep link surfaced inside the under-use warning. */
  readonly warningActionHref?: string;
  /** Admin-only action controls (rendered in the header on the staff variant). */
  readonly staffActions?: React.ReactNode;
  /**
   * Staff variant: the viewed member's company name. When set, the under-use
   * warning speaks about that company ("Acme has used 10% of its benefits")
   * instead of the member-facing "you've used". Omitted on the member portal.
   */
  readonly staffSubjectName?: string;
  /**
   * 059-membership-suspension Task 18 — renders an amber "Suspended" badge
   * beside the title when the member's benefits are temporarily paused
   * (`deriveMembershipAccess(...).access === 'suspended'`). Mirrors the
   * Task 16 admin-directory badge exactly: distinct icon (PauseCircle) +
   * distinct visible label + distinct sr-only phrase, never colour-alone.
   * Omitted/`false` on the member portal's own benefits view (only the two
   * F9 admin surfaces — the dedicated benefits page and the member-detail
   * inline preview — pass this prop).
   */
  readonly suspended?: boolean;
  /**
   * Pass A · Section 2 — compact preview mode for the admin member-detail
   * inline quota summary. Keeps only the quantifiable quota bars and drops
   * the live-freshness note, per-benefit action deep-links, the
   * active-benefits badge section, and the empty-state illustration so the
   * card reads as a tight at-a-glance summary. The full surface lives at
   * the dedicated `/admin/members/[id]/benefits` page (linked via
   * `previewHref`).
   */
  readonly compact?: boolean;
  /** "Full benefits →" deep link rendered in the header when `compact`. */
  readonly previewHref?: string;
  /**
   * 056 fix #1 — when set, the card title renders as a real `<h2 id>` and the
   * id is wired to a wrapping `<section aria-labelledby>` so the card appears
   * in the SR heading tree. Omitted on surfaces that don't need section
   * landmark semantics (the heading still renders as an `<h2>` either way).
   */
  readonly headingId?: string;
  /**
   * Additional CSS classes forwarded to the root `<Card>`. Used by the
   * compact preview wrapper to add `h-full flex flex-col` for equal-height
   * alignment in the 2-col grid on the member-detail page. Not applied on
   * the standalone benefits page or the portal (they don't pass this prop).
   */
  readonly className?: string;
}

function useFormatDate(locale: string): (iso: string) => string {
  // `timeZone` pinned — hydration safety (2026-07-31 #418 incident class):
  // a timestamp ≥ 17:00 UTC formats to DIFFERENT calendar days on the UTC
  // server vs a Bangkok browser. See format-date-localised.ts's
  // timezone-default doc.
  return (iso: string) =>
    new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      dateStyle: 'medium',
      timeZone: 'Asia/Bangkok',
    }).format(new Date(iso));
}

export function BenefitUsageCard({
  locale,
  membershipYear,
  elapsedYearPct,
  quantifiable,
  active,
  aggregateConsumedPct,
  underUseWarning,
  warningActionHref,
  staffActions,
  staffSubjectName,
  suspended = false,
  compact = false,
  previewHref,
  headingId,
  className,
}: BenefitUsageCardProps): React.ReactElement {
  const t = useTranslations('benefits');
  const formatDate = useFormatDate(locale);
  const hasContent = quantifiable.length > 0 || active.length > 0;

  const title = (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{t('card.title', { year: formatCalendarYear(membershipYear, locale) })}</span>
      {suspended && (
        // Non-colour-alone encoding, mirrors Task 16's directory badge:
        // distinct icon + distinct visible label + distinct sr-only phrase.
        <Badge tone="warning" icon={<PauseCircle aria-hidden="true" />}>
          <span aria-hidden="true">{t('card.suspendedBadge')}</span>
          <span className="sr-only">{t('card.suspendedBadgeSr')}</span>
        </Badge>
      )}
    </span>
  );

  return (
    // Stable settle hook for the a11y e2e scan: the Suspense skeleton has no such
    // testid, so a scan can wait for the LOADED card before running axe (F9-QA-03).
    // Spec 122 US3: AURA card (`Main` / `Benefits` boards). The title is a real
    // <h2> (056 fix #1) and, with `headingId`, labels the card.
    <AuraCard
      data-testid="benefit-usage-card"
      className={className}
      title={title}
      headingLevel={2}
      {...(headingId ? { titleId: headingId } : {})}
      // Figures are computed live per request (no cache) — surface the
      // freshness so a viewer knows they are current (spec edge case).
      // Omitted in the compact preview to keep the summary tight.
      description={compact ? undefined : t('card.liveNote')}
      actions={
        !compact && staffActions !== undefined ? (
          <div className="flex shrink-0 items-center gap-2">{staffActions}</div>
        ) : undefined
      }
      footer={
        compact && previewHref !== undefined ? (
          // As on the Main board: a footer text link with a 44px target.
          <Link
            href={previewHref}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
          >
            {t('card.fullBenefits')}
            <ArrowRight aria-hidden="true" size={16} className="aura-icon" />
          </Link>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {/* The warning only fires when there's a real aggregate (a member with
            no quantifiable benefits never warns), so aggregateConsumedPct is
            non-null here — assert it rather than masking with `?? 0`, which
            would render a misleading 0% if the invariant ever broke (R I-4). */}
        {underUseWarning && aggregateConsumedPct !== null && (
          <UnderUseWarning
            elapsedYearPct={elapsedYearPct}
            consumedPct={aggregateConsumedPct}
            {...(warningActionHref !== undefined ? { actionHref: warningActionHref } : {})}
            {...(staffSubjectName !== undefined ? { subjectName: staffSubjectName } : {})}
          />
        )}

        {!hasContent && (
          <div className="aura-empty">
            <span className="aura-empty__icon" aria-hidden>
              <PackageOpen className="size-6" />
            </span>
            <p className="aura-empty__title">{t('card.emptyTitle')}</p>
            <p className="aura-empty__text">{t('card.empty')}</p>
          </div>
        )}

        {quantifiable.length > 0 && (
          <ul className="flex flex-col gap-4">
            {quantifiable.map((b) => (
              <li key={b.key} className="flex flex-col gap-1.5">
                <Progress
                  label={t(`benefit.${b.key}`)}
                  value={b.used}
                  max={b.entitlement}
                  showValue
                  valueLabel={t('card.usedOf', { used: b.used, total: b.entitlement })}
                />
                <div className="flex items-center justify-between gap-2 text-[13px] text-[var(--aura-fg-secondary)]">
                  <span>
                    {b.lastUsedAt === null
                      ? t('card.neverUsed')
                      : t('card.lastUsed', { date: formatDate(b.lastUsedAt) })}
                  </span>
                  {!compact && b.actionHref !== undefined && (
                    <Link
                      href={b.actionHref}
                      className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
                    >
                      {t(`benefit.action.${b.key}`)}
                      {/* SR context: "Compose" alone is ambiguous when tabbing
                          through links — name the benefit (R I-8). */}
                      <span className="sr-only">{t(`benefit.${b.key}`)}</span>
                      <ArrowRight aria-hidden="true" size={14} className="aura-icon" />
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!compact && active.length > 0 && (
          <div className="flex flex-col gap-2">
            <Separator />
            <p className="text-[13px] font-medium text-[var(--aura-fg-secondary)]">
              {t('card.activeHeading')}
            </p>
            <ul className="flex flex-wrap gap-2">
              {active.map((a) => (
                <li key={a.key}>
                  <Badge>{t(`active.${a.key}`)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AuraCard>
  );
}

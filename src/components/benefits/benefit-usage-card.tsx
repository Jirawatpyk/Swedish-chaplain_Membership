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
 */
import Link from 'next/link';
import { ArrowRight, PackageOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
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
  return (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
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
  compact = false,
  previewHref,
  headingId,
  className,
}: BenefitUsageCardProps): React.ReactElement {
  const t = useTranslations('benefits');
  const formatDate = useFormatDate(locale);
  const hasContent = quantifiable.length > 0 || active.length > 0;

  return (
    // Stable settle hook for the a11y e2e scan: the Suspense skeleton has no such
    // testid, so a scan can wait for the LOADED card before running axe (F9-QA-03).
    <Card data-testid="benefit-usage-card" className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          {/* 056 fix #1 — real <h2> in place of the CardTitle <div> so the
              card lands in the SR heading tree under the page <h1>. */}
          <h2
            {...(headingId ? { id: headingId } : {})}
            className="font-heading text-base font-medium leading-snug"
          >
            {t('card.title', { year: membershipYear })}
          </h2>
          {/* Figures are computed live per request (no cache) — surface the
              freshness so a viewer knows they are current (spec edge case).
              Omitted in the compact preview to keep the summary tight. */}
          {!compact && (
            <p className="text-caption text-muted-foreground">
              {t('card.liveNote')}
            </p>
          )}
        </div>
        {compact && previewHref !== undefined ? (
          <Link
            href={previewHref}
            className={cn(buttonVariants({ variant: 'outline' }), 'shrink-0')}
          >
            {t('card.fullBenefits')}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        ) : (
          staffActions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{staffActions}</div>
          )
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* The warning only fires when there's a real aggregate (a member with
            no quantifiable benefits never warns), so aggregateConsumedPct is
            non-null here — assert it rather than masking with `?? 0`, which
            would render a misleading 0% if the invariant ever broke (R I-4). */}
        {underUseWarning && aggregateConsumedPct !== null && (
          <UnderUseWarning
            elapsedYearPct={elapsedYearPct}
            consumedPct={aggregateConsumedPct}
            {...(warningActionHref !== undefined ? { actionHref: warningActionHref } : {})}
          />
        )}

        {!hasContent && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <PackageOpen aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="font-medium">{t('card.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('card.empty')}</p>
          </div>
        )}

        {quantifiable.length > 0 && (
          <ul className="flex flex-col gap-4">
            {quantifiable.map((b) => (
              <li key={b.key} className="flex flex-col gap-1.5">
                <ProgressBar
                  label={t(`benefit.${b.key}`)}
                  value={b.used}
                  max={b.entitlement}
                  formatValue={(_pct, value, max) =>
                    t('card.usedOf', { used: value, total: max })
                  }
                />
                <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
                  <span>
                    {b.lastUsedAt === null
                      ? t('card.neverUsed')
                      : t('card.lastUsed', { date: formatDate(b.lastUsedAt) })}
                  </span>
                  {!compact && b.actionHref !== undefined && (
                    <Link
                      href={b.actionHref}
                      className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {t(`benefit.action.${b.key}`)}
                      {/* SR context: "Compose" alone is ambiguous when tabbing
                          through links — name the benefit (R I-8). */}
                      <span className="sr-only">{t(`benefit.${b.key}`)}</span>
                      <ArrowRight aria-hidden="true" className="size-3.5" />
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
            <p className="text-caption font-medium text-muted-foreground">
              {t('card.activeHeading')}
            </p>
            <ul className="flex flex-wrap gap-2">
              {active.map((a) => (
                <li key={a.key}>
                  <Badge variant="secondary">{t(`active.${a.key}`)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

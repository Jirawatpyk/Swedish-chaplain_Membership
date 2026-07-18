/**
 * 107-auto-invoice Task 13 — per-row decision context for the admin
 * auto-renewal review queue (`origin='auto_renewal' AND status='draft'`).
 *
 * Rewritten after the Task 13 review round (both a financial-integrity /
 * thai-tax pass and an enterprise-UX pass) found the first cut's signals
 * did not faithfully represent what would happen if the treasurer clicked:
 *
 *   - A1: the bill-year note fired on 100% of rows (a 12-month term always
 *     lands the coverage year one past the plan year) — dropped that
 *     predicate; the surviving "bill year stale" signal now compares
 *     against TODAY's fiscal year instead, which is false for the common
 *     case.
 *   - A2: "would be refused" only modelled ONE of `issueAutoDraftedRenewal`'s
 *     three refusal reasons — now models all three
 *     (`refusalReason.kind`), each with its own visible copy.
 *   - A3: the price badge conflated "confirmed different" with "couldn't
 *     check" — now `priceChanged` and `priceUnverifiable` are distinct,
 *     mutually-exclusive states with distinct copy and a non-directional
 *     icon (the price may have gone DOWN, not just up).
 *
 * Severity ladder (review A4) borrows the 4-tier colour system from
 * `src/components/renewals/risk-score-badge.tsx` (emerald/amber/orange/red
 * + `role="img"`) rather than inventing new tokens:
 *
 *   critical (red)    → would be refused — the ONLY state on its own line.
 *   at-risk (orange)  → unable to verify (whole row, or price specifically).
 *   warning (amber)   → price confirmed changed.
 *   healthy (emerald) → bill year is stale — benign, expected under the
 *                       rolling-anchor model, least alarming of the four.
 *
 * Review A5: the frozen/current prices are DECISION NUMBERS (needed to
 * judge whether the change is reasonable) — always-visible text, never
 * tooltip-only (Base UI tooltips are hover/focus-only, unreachable on
 * touch — `ux-standards.md` §9.1 mandates mobile-first from 320px).
 * Tooltips are reserved for supplementary text that carries no numbers
 * (`unresolvedTooltip`, `billYearStaleTooltip`).
 *
 * Review A7: the conflicting-invoice link is the only route to inspect a
 * refused row's competing bill — sized to the project's 44×44 minimum
 * tappable target (`ux-standards.md` §9.1), not a bare inline text link.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertCircleIcon,
  HelpCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The 4-tier severity ladder, borrowed verbatim from `risk-score-badge.tsx`. */
type SeverityTier = 'critical' | 'atRisk' | 'warning' | 'healthy';

const TIER_CLASSES: Record<SeverityTier, string> = {
  critical:
    'bg-red-100 text-red-900 ring-red-300 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
  atRisk:
    'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800',
  warning:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  healthy:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
};

/** A single severity-coded pill. `role="img"` + `aria-label` mirrors
 * `RiskScoreBadge` (ARIA prohibits `aria-label` on a roleless span, and the
 * icon is `aria-hidden` so the badge reads as one labelled unit). */
function SeverityBadge({
  tier,
  icon: Icon,
  label,
  ariaLabel,
  testId,
}: {
  readonly tier: SeverityTier;
  readonly icon: typeof AlertCircleIcon;
  readonly label: string;
  readonly ariaLabel: string;
  readonly testId: string;
}) {
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
        TIER_CLASSES[tier],
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

export type AutoRenewalRefusalReasonClient =
  | { readonly kind: 'plan_year_drift' }
  | { readonly kind: 'member_terminated' }
  | { readonly kind: 'duplicate_live_bill'; readonly conflictingInvoiceId: string };

/** Client-facing shape — mirrors `InvoicesTableRow['queueMeta']` (non-null).
 * Prices arrive PRE-FORMATTED (`formatSatangThb`, computed server-side) —
 * this component never does money math. */
export interface AutoRenewalQueueMeta {
  /** Whole-row enrichment failed (network/DB blip) — distinct from `priceUnverifiable` below, which is price-specific and lets the other signals still render. */
  readonly unresolved: boolean;
  readonly stalenessDays: number;
  readonly frozenPriceDisplay: string | null;
  readonly currentCataloguePriceDisplay: string | null;
  readonly priceChanged: boolean;
  readonly priceUnverifiable: boolean;
  readonly planYear: number;
  readonly currentFiscalYear: number;
  readonly billYearStale: boolean;
  readonly refusalReason: AutoRenewalRefusalReasonClient | null;
}

export function AutoRenewalQueueBadges({ meta }: { meta: AutoRenewalQueueMeta }) {
  const t = useTranslations('admin.invoices.list.queue');

  const refusalCopy = (reason: AutoRenewalRefusalReasonClient): string => {
    switch (reason.kind) {
      case 'plan_year_drift':
        return t('refusalReason.planYearDrift');
      case 'member_terminated':
        return t('refusalReason.memberTerminated');
      case 'duplicate_live_bill':
        return t('refusalReason.duplicateLiveBill');
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      {meta.refusalReason && (
        <div className="flex flex-col items-start gap-1">
          <SeverityBadge
            tier="critical"
            icon={AlertCircleIcon}
            label={t('wouldBeRefused')}
            ariaLabel={t('wouldBeRefusedAria')}
            testId="queue-would-be-refused"
          />
          <p className="text-xs text-muted-foreground">
            {refusalCopy(meta.refusalReason)}
          </p>
          {meta.refusalReason.kind === 'duplicate_live_bill' && (
            <Link
              href={`/admin/invoices/${meta.refusalReason.conflictingInvoiceId}`}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'min-h-11 gap-1 px-3',
              )}
            >
              {t('viewConflictingInvoice')}
            </Link>
          )}
        </div>
      )}

      {meta.unresolved ? (
        <TooltipProvider delay={200}>
          <Tooltip>
            <TooltipTrigger
              render={(props) => (
                <span {...props}>
                  <SeverityBadge
                    tier="atRisk"
                    icon={HelpCircleIcon}
                    label={t('unresolved')}
                    ariaLabel={t('unresolvedAria')}
                    testId="queue-unresolved"
                  />
                </span>
              )}
            />
            <TooltipContent>{t('unresolvedTooltip')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <>
          {meta.priceUnverifiable && (
            <div className="flex flex-col items-start gap-0.5">
              <SeverityBadge
                tier="atRisk"
                icon={HelpCircleIcon}
                label={t('priceUnverifiable')}
                ariaLabel={t('priceUnverifiableAria')}
                testId="queue-price-unverifiable"
              />
              {meta.frozenPriceDisplay && (
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  data-testid="queue-price-figures"
                >
                  {t('priceFrozenOnly', { frozen: meta.frozenPriceDisplay })}
                </span>
              )}
            </div>
          )}
          {meta.priceChanged && (
            <div className="flex flex-col items-start gap-0.5">
              <SeverityBadge
                tier="warning"
                icon={AlertTriangleIcon}
                label={t('priceChanged')}
                ariaLabel={t('priceChangedAria', {
                  frozen: meta.frozenPriceDisplay ?? '',
                  current: meta.currentCataloguePriceDisplay ?? '',
                })}
                testId="queue-price-changed"
              />
              {/* Review A5 — decision numbers, always visible (never tooltip-only). */}
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="queue-price-figures"
              >
                {meta.frozenPriceDisplay} → {meta.currentCataloguePriceDisplay}
              </span>
            </div>
          )}
          {meta.billYearStale && (
            <TooltipProvider delay={200}>
              <Tooltip>
                <TooltipTrigger
                  render={(props) => (
                    <span {...props}>
                      <SeverityBadge
                        tier="healthy"
                        icon={InfoIcon}
                        label={t('billYearStale')}
                        ariaLabel={t('billYearStaleAria', {
                          currentFiscalYear: meta.currentFiscalYear,
                        })}
                        testId="queue-bill-year-stale"
                      />
                    </span>
                  )}
                />
                <TooltipContent>
                  {t('billYearStaleTooltip', {
                    planYear: meta.planYear,
                    currentFiscalYear: meta.currentFiscalYear,
                  })}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </>
      )}

      <span
        className="text-xs text-muted-foreground"
        data-testid="queue-staleness"
      >
        {t('staleness', { days: meta.stalenessDays })}
      </span>
    </div>
  );
}

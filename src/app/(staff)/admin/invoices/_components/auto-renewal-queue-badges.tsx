/**
 * 107-auto-invoice Task 13 — per-row decision context for the admin
 * auto-renewal review queue (`origin='auto_renewal' AND status='draft'`).
 *
 * Extracted from `InvoicesTable` into its own component so it can be
 * rendered + tested in isolation (component test:
 * `tests/unit/components/invoices/auto-renewal-queue-badges.test.tsx`).
 *
 * Rendering priority (WCAG 1.4.1 — every state pairs an icon with text,
 * never colour alone):
 *   1. **Would-be-refused** — the ONLY state that gets its own line +
 *      destructive styling. This is Task 9's content guard predicted
 *      ahead of time (a live membership bill already exists for this
 *      plan year); it is deliberately visually distinct from the two
 *      informational notes below, per the task brief: "must render as
 *      its own state with a clear reason, NOT as a generic error at
 *      click time."
 *   2. **Unresolved** — the F8 enrichment could not be computed for this
 *      row (degraded lookup, or an orphaned draft with no stamped
 *      cycle). Rendered instead of drift/bill-year notes (which would be
 *      unverifiable), never as a silent "looks fine".
 *   3. **Drift** + **bill-year ≠ coverage-year** — neutral, informational
 *      notes; both can appear together.
 *   4. **Staleness** — plain muted text, always shown last.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon, HelpCircleIcon, TrendingUpIcon, InfoIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/** Client-facing shape — mirrors `InvoicesTableRow['queueMeta']` (non-null). */
export interface AutoRenewalQueueMeta {
  readonly unresolved: boolean;
  readonly stalenessDays: number;
  readonly driftFlagged: boolean;
  readonly frozenPriceThb: string | null;
  readonly currentCataloguePriceThb: string | null;
  readonly billYearCoverageYearMismatch: boolean;
  readonly coverageYear: number | null;
  readonly wouldBeRefused: boolean;
  readonly conflictingInvoiceId: string | null;
}

export function AutoRenewalQueueBadges({ meta }: { meta: AutoRenewalQueueMeta }) {
  const t = useTranslations('admin.invoices.list.queue');

  return (
    <div className="flex flex-col items-start gap-1.5">
      {meta.wouldBeRefused && (
        <div className="flex flex-col items-start gap-0.5">
          <Badge
            variant="destructive"
            className="gap-1"
            data-testid="queue-would-be-refused"
            aria-label={t('wouldBeRefusedAria')}
          >
            <AlertCircleIcon className="size-3" aria-hidden="true" />
            {t('wouldBeRefused')}
          </Badge>
          {meta.conflictingInvoiceId && (
            <Link
              href={`/admin/invoices/${meta.conflictingInvoiceId}`}
              className="text-xs underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
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
                <Badge
                  {...props}
                  variant="outline"
                  className="gap-1 font-normal text-muted-foreground"
                  data-testid="queue-unresolved"
                >
                  <HelpCircleIcon className="size-3" aria-hidden="true" />
                  {t('unresolved')}
                </Badge>
              )}
            />
            <TooltipContent>{t('unresolvedTooltip')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {meta.driftFlagged && (
            <TooltipProvider delay={200}>
              <Tooltip>
                <TooltipTrigger
                  render={(props) => (
                    <Badge
                      {...props}
                      variant="secondary"
                      className="gap-1 font-normal"
                      data-testid="queue-drift"
                      aria-label={
                        meta.frozenPriceThb && meta.currentCataloguePriceThb
                          ? t('driftAria', {
                              frozen: meta.frozenPriceThb,
                              current: meta.currentCataloguePriceThb,
                            })
                          : t('drift')
                      }
                    >
                      <TrendingUpIcon className="size-3" aria-hidden="true" />
                      {t('drift')}
                    </Badge>
                  )}
                />
                <TooltipContent>
                  {meta.frozenPriceThb && meta.currentCataloguePriceThb
                    ? t('driftTooltip', {
                        frozen: meta.frozenPriceThb,
                        current: meta.currentCataloguePriceThb,
                      })
                    : t('driftTooltipUnknown')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {meta.billYearCoverageYearMismatch && (
            <TooltipProvider delay={200}>
              <Tooltip>
                <TooltipTrigger
                  render={(props) => (
                    <Badge
                      {...props}
                      variant="outline"
                      className="gap-1 font-normal"
                      data-testid="queue-bill-year-mismatch"
                    >
                      <InfoIcon className="size-3" aria-hidden="true" />
                      {t('billYearMismatch')}
                    </Badge>
                  )}
                />
                <TooltipContent>
                  {meta.coverageYear !== null
                    ? t('billYearMismatchTooltip', { coverageYear: meta.coverageYear })
                    : t('billYearMismatchTooltipUnknown')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
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

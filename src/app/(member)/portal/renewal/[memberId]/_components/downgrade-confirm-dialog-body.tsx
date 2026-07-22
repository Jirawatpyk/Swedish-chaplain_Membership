/**
 * WP5 — the downgrade confirmation dialog body (split out so tests can
 * force-open it: `<AlertDialog open onOpenChange={()=>{}}><Body/></AlertDialog>`;
 * a full click-to-open flow deadlocks Base UI's portal focus in jsdom).
 *
 * Shows the member exactly what a lower-priced switch costs them: the
 * before/after price, the yearly quota reductions we know about, and — when
 * they have already used more of a benefit than the new plan includes — an
 * over-quota warning. No `finalFocus` is wired (C-7): the trigger is a
 * programmatically-opened dialog, so Base UI's default focus return is
 * correct and a `finalFocus` override would be inert on success and regress
 * Cancel.
 */
'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { InlineAlert } from '@/components/ui/inline-alert';
import { PriceDiffPanel } from './price-diff-panel';

/** Per-benefit quota move: `from` current-plan quota → `to` new-plan quota, plus `used` this cycle. `null` = unlimited. */
export interface BenefitQuotaDelta {
  readonly from: number | null;
  readonly to: number | null;
  readonly used: number;
}

export interface DowngradeConfirmDialogBodyProps {
  readonly currentLabel: string;
  readonly newLabel: string;
  readonly currentPriceMinorUnits: number;
  readonly newPriceMinorUnits: number;
  readonly eblast?: BenefitQuotaDelta;
  readonly culturalTickets?: BenefitQuotaDelta;
  readonly submitting: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** True when we can render a concrete "N → M" numeric reduction. */
function hasNumericDelta(d: BenefitQuotaDelta | undefined): d is BenefitQuotaDelta & {
  from: number;
  to: number;
} {
  return d !== undefined && d.from !== null && d.to !== null;
}

/** True when the member has already consumed more than the new plan includes. */
function isOverQuota(d: BenefitQuotaDelta | undefined): d is BenefitQuotaDelta & { to: number } {
  return d !== undefined && d.to !== null && d.used > d.to;
}

export function DowngradeConfirmDialogBody({
  currentLabel,
  newLabel,
  currentPriceMinorUnits,
  newPriceMinorUnits,
  eblast,
  culturalTickets,
  submitting,
  onConfirm,
  onCancel,
}: DowngradeConfirmDialogBodyProps) {
  const t = useTranslations('portal.renewal.downgrade');
  const tBenefits = useTranslations('portal.renewal.benefits');

  const showEblastRow = hasNumericDelta(eblast);
  const showCulturalRow = hasNumericDelta(culturalTickets);
  const anyQuotaRow = showEblastRow || showCulturalRow;

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('title')}</AlertDialogTitle>
        <AlertDialogDescription>
          {t('description', { currentLabel, newLabel })}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <PriceDiffPanel
        currentPriceMinorUnits={currentPriceMinorUnits}
        newPriceMinorUnits={newPriceMinorUnits}
      />

      {anyQuotaRow && (
        <section className="flex flex-col gap-2 text-sm">
          <p className="font-medium">{t('losesHeading')}</p>
          <ul className="list-disc space-y-1 pl-5">
            {showEblastRow && (
              <li>{t('quotaEblast', { from: eblast.from, to: eblast.to })}</li>
            )}
            {showCulturalRow && (
              <li>
                {t('quotaCulturalTickets', {
                  from: culturalTickets.from,
                  to: culturalTickets.to,
                })}
              </li>
            )}
          </ul>
        </section>
      )}

      {isOverQuota(eblast) && (
        <InlineAlert tone="warning" role="status">
          {t('overQuotaWarning', {
            used: eblast.used,
            quota: eblast.to,
            benefitName: tBenefits('name.eblast'),
          })}
        </InlineAlert>
      )}
      {isOverQuota(culturalTickets) && (
        <InlineAlert tone="warning" role="status">
          {t('overQuotaWarning', {
            used: culturalTickets.used,
            quota: culturalTickets.to,
            benefitName: tBenefits('name.cultural_ticket'),
          })}
        </InlineAlert>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel onClick={onCancel}>{t('cancelCta')}</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} disabled={submitting}>
          {/* Busy spinner while the renewal POST runs (ux-standards § 6.2).
              aria-hidden preserves the button's accessible name; the global
              reduced-motion rule (globals.css § 19) neutralises .animate-spin. */}
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('confirmCta')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

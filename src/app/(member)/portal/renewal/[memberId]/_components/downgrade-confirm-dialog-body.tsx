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
 *
 * C4 a11y (WCAG 4.1.3): the over-quota warning is referenced from the
 * dialog popup's `aria-describedby` (alongside the base description) so a
 * screen reader ANNOUNCES it the moment the dialog opens. A `role="status"`
 * region whose content is already present at open does not re-announce — the
 * warning's InlineAlert is therefore visual-only (`role="presentation"`) and
 * the announcement rides on the accessible description instead.
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

/**
 * Stable ids wiring the over-quota fact into the dialog's accessible
 * description (C4 / WCAG 4.1.3). Exported so a11y tests assert the wiring
 * against the source of truth rather than a duplicated magic string.
 */
export const DOWNGRADE_DIALOG_DESC_ID = 'downgrade-dialog-desc';
export const DOWNGRADE_DIALOG_OVERQUOTA_ID = 'downgrade-dialog-overquota';

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

  // C4 — collect the over-quota facts up front so we can BOTH render the
  // visual warning banner(s) AND reference them from the popup's
  // `aria-describedby`, so they are announced when the dialog opens.
  const overQuotaWarnings: Array<{ readonly key: string; readonly text: string }> = [];
  if (isOverQuota(eblast)) {
    overQuotaWarnings.push({
      key: 'eblast',
      text: t('overQuotaWarning', {
        used: eblast.used,
        quota: eblast.to,
        benefitName: tBenefits('name.eblast'),
      }),
    });
  }
  if (isOverQuota(culturalTickets)) {
    overQuotaWarnings.push({
      key: 'cultural',
      text: t('overQuotaWarning', {
        used: culturalTickets.used,
        quota: culturalTickets.to,
        benefitName: tBenefits('name.cultural_ticket'),
      }),
    });
  }
  const hasOverQuota = overQuotaWarnings.length > 0;

  return (
    <AlertDialogContent
      // When over quota, EXTEND the auto-wired description (Base UI points
      // `aria-describedby` at the explicit-id `AlertDialogDescription`) with
      // the over-quota region so the screen reader hears both on open. When
      // NOT over quota, omit the prop entirely so Base UI's own wiring stands.
      {...(hasOverQuota
        ? {
            'aria-describedby': `${DOWNGRADE_DIALOG_DESC_ID} ${DOWNGRADE_DIALOG_OVERQUOTA_ID}`,
          }
        : {})}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{t('title')}</AlertDialogTitle>
        <AlertDialogDescription id={DOWNGRADE_DIALOG_DESC_ID}>
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

      {hasOverQuota && (
        <div id={DOWNGRADE_DIALOG_OVERQUOTA_ID} className="flex flex-col gap-2">
          {overQuotaWarnings.map((w) => (
            // `role="presentation"` — visual-only. The fact is announced on
            // open via the popup's `aria-describedby` (this region), not as a
            // separate live region, which would not re-announce pre-existing
            // content — the exact WCAG 4.1.3 gap C4 closes.
            <InlineAlert key={w.key} tone="warning" role="presentation">
              {w.text}
            </InlineAlert>
          ))}
        </div>
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

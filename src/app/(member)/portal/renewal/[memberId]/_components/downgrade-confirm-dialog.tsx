/**
 * WP5 — the downgrade confirmation dialog.
 *
 * Shows the member exactly what a lower-priced switch costs them: the
 * before/after price, the yearly quota reductions we know about, and — when
 * they have already used more of a benefit than the new plan includes — an
 * over-quota warning. Only its Confirm sends `acknowledgeDowngrade: true`.
 *
 * Spec 122 US7c: an AURA alertdialog (Session 2026-10-01, US7c start: the
 * board draws none, the maintainer kept it because it gates the money
 * request). Cancel takes first focus; while the request runs Confirm is busy
 * and the dialog cannot be dismissed. Focus returns to the CTA that opened it.
 *
 * C4 a11y (WCAG 4.1.3): the over-quota warning is added to the dialog's
 * `aria-describedby` (AURA keeps its own description id first) so a screen
 * reader ANNOUNCES it the moment the dialog opens. A live region whose content
 * is already present at open does not re-announce, so the warnings themselves
 * are visual-only alerts (`role="none"`).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Alert, Button, Dialog } from '@jirawatpyk/aura-react';
import { PriceDiffPanel } from './price-diff-panel';

/**
 * Stable id wiring the over-quota fact into the dialog's accessible
 * description (C4 / WCAG 4.1.3). Exported so a11y tests assert the wiring
 * against the source of truth rather than a duplicated magic string.
 */
export const DOWNGRADE_DIALOG_OVERQUOTA_ID = 'downgrade-dialog-overquota';

/** Per-benefit quota move: `from` current-plan quota → `to` new-plan quota, plus `used` this cycle. `null` = unlimited. */
export interface BenefitQuotaDelta {
  readonly from: number | null;
  readonly to: number | null;
  readonly used: number;
}

export interface DowngradeConfirmDialogProps {
  readonly open: boolean;
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

export function DowngradeConfirmDialog({
  open,
  currentLabel,
  newLabel,
  currentPriceMinorUnits,
  newPriceMinorUnits,
  eblast,
  culturalTickets,
  submitting,
  onConfirm,
  onCancel,
}: DowngradeConfirmDialogProps) {
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
    <Dialog
      role="alertdialog"
      open={open}
      onClose={onCancel}
      dismissible={!submitting}
      title={t('title')}
      description={t('description', { currentLabel, newLabel })}
      {...(hasOverQuota ? { 'aria-describedby': DOWNGRADE_DIALOG_OVERQUOTA_ID } : {})}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={onCancel} disabled={submitting}>
            {t('cancelCta')}
          </Button>
          <Button onClick={onConfirm} loading={submitting}>
            {t('confirmCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <PriceDiffPanel
          currentPriceMinorUnits={currentPriceMinorUnits}
          newPriceMinorUnits={newPriceMinorUnits}
        />

        {anyQuotaRow && (
          <section className="flex flex-col gap-[var(--aura-space-2)] text-sm">
            <p className="font-semibold">{t('losesHeading')}</p>
            <ul className="list-disc space-y-1 ps-5">
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
          <div id={DOWNGRADE_DIALOG_OVERQUOTA_ID} className="flex flex-col gap-[var(--aura-space-2)]">
            {overQuotaWarnings.map((w) => (
              // `role="none"` — visual-only; announced on open through the
              // dialog's `aria-describedby` (C4), not as a live region.
              <Alert key={w.key} tone="warning" role="none">
                {w.text}
              </Alert>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

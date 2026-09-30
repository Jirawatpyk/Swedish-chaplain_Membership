'use client';

/**
 * WP7 — unconditional plan-change confirm dialog (BP3, ux-standards § 6.2).
 *
 * Gates EVERY member-edit plan change (id OR year) behind an explicit confirm
 * that shows the old→new plan + annual fees, BEFORE any request. Composes with
 * the existing server-driven escalations: this dialog opens pre-request, so the
 * 409 bundle-change / 422 override dialogs (which open post-request from within
 * the submit) never double-prompt.
 *
 * DEFAULT (non-destructive) variant — a plan change is neutral. Initial focus
 * is the Cancel button (the safe action). Per correction C-7 + critique D10,
 * this dialog wires NO `finalFocus` hook: its opener is the form's Save
 * button, which survives on Cancel/ESC (focus returns to it) and on success
 * the whole form unmounts via `router.push`, so there is no stranded-focus
 * case to engineer around.
 *
 * Spec 122 US5b-2 (T578): AURA `Dialog` as the board draws it
 * (`Admin-member-plan-change`) — the Current → New tiles with the annual
 * fee excl. VAT, "What this does and does not change" as a heading over its
 * three points, then Cancel and "Change plan".
 */
import { ArrowRightIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import {
  formatPlanFee,
  PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL,
  type PlanChangeSummary,
} from './plan-change-summary';

export interface PlanChangeConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly summary: PlanChangeSummary | null;
  readonly onConfirm: () => void;
  readonly submitting: boolean;
}

export function PlanChangeConfirmDialog({
  open,
  onOpenChange,
  summary,
  onConfirm,
  submitting,
}: PlanChangeConfirmDialogProps) {
  const t = useTranslations('admin.members.planChangeConfirm');
  const locale = useLocale();

  const fee = (minorUnits: number | null, currencyCode: string | null): string =>
    minorUnits === null
      ? t('feeUnknown')
      : formatPlanFee(minorUnits, locale, currencyCode ?? 'THB');

  const tile = (label: string, plan: string, amount: string) => (
    <div className="min-w-0 flex-1 rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-canvas)] p-3">
      <div className="text-xs text-[var(--aura-fg-secondary)]">{label}</div>
      <div className="font-semibold text-[var(--aura-fg-primary)]">{plan}</div>
      <div className="mt-1 text-xs text-[var(--aura-fg-secondary)]">
        {t('feeLabel')} <span className="tabular-nums text-[var(--aura-fg-primary)]">{amount}</span>
      </div>
    </div>
  );

  return (
    <Dialog
      // A confirmation that gates a request (as the old AlertDialog): a stray
      // scrim click doesn't dismiss it; Escape and Cancel do.
      role="alertdialog"
      open={open}
      onClose={() => {
        if (!submitting) onOpenChange(false);
      }}
      dismissible={!submitting}
      title={t('title')}
      description={t('description')}
      footer={
        <>
          {/* The safe action takes focus (a plan change is neutral, not
              destructive — ux-standards § 6.2). */}
          <Button variant="secondary" data-autofocus onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button loading={submitting} disabled={submitting} onClick={onConfirm}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      {summary ? (
        <div className="flex flex-col gap-4">
          {/* Current → New as the board draws it; stacked on a phone. */}
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {tile(t('currentPlan'), summary.oldPlanLabel, fee(summary.oldFeeMinorUnits, summary.currencyCode))}
            <ArrowRightIcon className="size-4 shrink-0 self-center text-[var(--aura-fg-secondary)] max-sm:rotate-90" aria-hidden="true" />
            {tile(t('newPlan'), summary.newPlanLabel, fee(summary.newFeeMinorUnits, summary.currencyCode))}
          </div>

          {summary.yearOnly ? (
            <p className="text-sm text-[var(--aura-fg-secondary)]">{t('yearOnlyNotice')}</p>
          ) : null}

          <section aria-labelledby="plan-change-effects" className="text-sm">
            <h3 id="plan-change-effects" className="font-semibold text-[var(--aura-fg-primary)]">
              {t('billingNoteHeading')}
            </h3>
            <ul className="mt-1 list-disc space-y-1 ps-5 text-[var(--aura-fg-secondary)]">
              <li>{t('billingNoteRecord')}</li>
              <li>{t('billingNoteCurrentInvoice')}</li>
              <li>
                {PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL
                  ? t('billingNoteFutureCyclesAutomatic')
                  : t('billingNoteFutureCycles')}
              </li>
            </ul>
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

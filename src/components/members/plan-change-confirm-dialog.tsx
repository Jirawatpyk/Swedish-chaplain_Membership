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
 * this dialog wires NO `finalFocus`/`id` hook: its trigger is the form's Save
 * button, which survives on Cancel/ESC (Base UI's default focus-return is
 * correct) and on success the whole form unmounts via `router.push`, so there
 * is no stranded-focus case to engineer around.
 */
import { useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
  const cancelRef = useRef<HTMLButtonElement>(null);

  const fee = (minorUnits: number | null, currencyCode: string | null): string =>
    minorUnits === null
      ? t('feeUnknown')
      : formatPlanFee(minorUnits, locale, currencyCode ?? 'THB');

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>

        {summary ? (
          <div className="space-y-3 text-left">
            <div className="grid grid-cols-2 gap-4 rounded-md border bg-muted/30 p-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">
                  {t('currentPlan')}
                </div>
                <div className="font-medium">{summary.oldPlanLabel}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('feeLabel')}:{' '}
                  {fee(summary.oldFeeMinorUnits, summary.currencyCode)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  {t('newPlan')}
                </div>
                <div className="font-medium">{summary.newPlanLabel}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('feeLabel')}:{' '}
                  {fee(summary.newFeeMinorUnits, summary.currencyCode)}
                </div>
              </div>
            </div>

            {summary.yearOnly ? (
              <p className="text-sm text-muted-foreground">
                {t('yearOnlyNotice')}
              </p>
            ) : null}

            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <p className="font-medium">{t('billingNoteHeading')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                <li>{t('billingNoteRecord')}</li>
                <li>{t('billingNoteCurrentInvoice')}</li>
                <li>
                  {PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL
                    ? t('billingNoteFutureCyclesAutomatic')
                    : t('billingNoteFutureCycles')}
                </li>
              </ul>
            </div>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={submitting}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction disabled={submitting} onClick={onConfirm}>
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

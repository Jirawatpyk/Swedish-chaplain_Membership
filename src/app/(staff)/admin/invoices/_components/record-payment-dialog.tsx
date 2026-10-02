'use client';

/**
 * F4 UX flow refactor — Record payment as Dialog (non-destructive form).
 *
 * Replaces the previous `/admin/invoices/[id]/pay` full-page route
 * with an in-context Dialog triggered from the invoice detail page.
 * Aligns with the project's short-form-action pattern:
 *   - F1 `invite-user-dialog` (4 fields, Dialog)
 *   - F1 `change-password-form-dialog` (3 fields, Dialog)
 *   - F3 `override-reason-dialog` (1 field, Dialog)
 *
 * Why Dialog (not AlertDialog):
 *   - Recording payment is a data-entry form, not a destructive
 *     confirmation. The admin is CAPTURING information, not just
 *     acknowledging consequences.
 *   - Dialog allows a richer multi-field layout without sacrificing
 *     the in-context overlay benefit (admin still sees the invoice
 *     total + document number in the background).
 *
 * The heavy lifting (field state, submission, toast) stays inside
 * `PaymentForm`; this component is a thin overlay shell. On success
 * the form calls `router.refresh()` which the dialog intercepts via
 * `onOpenChange(false)` handled in PaymentForm.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { PaymentForm } from './payment-form';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string | null;
  readonly issueDate: string | null;
  /**
   * Tenant-timezone (Asia/Bangkok) "today" as YYYY-MM-DD, computed
   * server-side. Threaded to `PaymentForm` as the payment-date default
   * + upper bound — never derived client-side from `new Date()` (UTC),
   * which breaks the date clamp for ~7h/day. See `PaymentForm.todayIso`.
   */
  readonly todayIso: string;
  /**
   * Spec 122 US8 (T804, `Admin-record-payment` board) — the summary box names
   * whose bill it is and the amount being recorded, pre-formatted by the
   * caller (this component never does money math). Both optional: without
   * them the box still names the bill.
   */
  readonly memberName?: string;
  readonly totalDisplay?: string;
  /**
   * 088 T021c / FR-035 — optional trigger overrides so the SAME money-mutation
   * dialog can be reused as a compact per-row "Record payment" quick action on
   * the invoice list (issued / overdue bills), not only as the full-size
   * primary CTA on the detail page. Defaults reproduce the detail-page trigger.
   *
   * `triggerId` defaults to `'record-payment'` (the payment-timeline empty-
   * state CTA scrolls to `#record-payment`). The list passes a per-row unique
   * id so rendering many dialogs never collides on a duplicate DOM id.
   */
  readonly triggerLabel?: string;
  /**
   * 088 T021c / a11y — optional accessible-name override for the trigger. The
   * per-row list action passes a number-bearing label ("Record payment for
   * {number}") so a screen-reader user navigating by button list (which strips
   * table-row context) knows WHICH invoice each money-mutation targets; the
   * detail-page CTA omits it (the page is the context) and keeps the visible
   * text as the accessible name.
   */
  readonly triggerAriaLabel?: string;
  readonly triggerVariant?: 'primary' | 'secondary' | 'ghost';
  readonly triggerSize?: 'sm' | 'md';
  readonly triggerId?: string;
  readonly triggerTestId?: string;
  /**
   * Spec 122 US8 (T809) — where focus goes after a successful payment. The
   * refresh turns the bill into a paid one and the trigger unmounts, so
   * focus would drop to `<body>`; the list passes the row's ⋯ (which
   * survives), and without one focus lands on `#main-content`.
   */
  readonly finalFocusFallbackId?: string;
};

/**
 * Record payment (088 FR-035) on AURA's dialog (spec 122 US8 T804). Below
 * 640px AURA's dialog is a bottom sheet (up to 92% of the height, rounded top
 * corners), which is the `Admin-record-payment-mobile` board — one component
 * for both widths.
 */
export function RecordPaymentDialog({
  invoiceId,
  documentNumber,
  issueDate,
  todayIso,
  memberName,
  totalDisplay,
  triggerLabel,
  triggerAriaLabel,
  triggerVariant = 'primary',
  triggerSize,
  triggerId = 'record-payment',
  triggerTestId = 'record-payment-trigger',
  finalFocusFallbackId,
}: Props) {
  const t = useTranslations('admin.invoices.pay');
  const tDetail = useTranslations('admin.invoices.detail');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // Raised right before the success close: the refresh that follows unmounts
  // the trigger, so focus must skip it (WCAG 2.4.3).
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef.current,
        trigger: document.getElementById(triggerId),
        fallback: finalFocusFallbackId ? document.getElementById(finalFocusFallbackId) : null,
        mainContent: document.getElementById('main-content'),
      }),
    [triggerId, finalFocusFallbackId],
  );

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      onOpen={() => {
        closedViaSuccessRef.current = false;
        setOpen(true);
      }}
      // No Escape or scrim close while the POST is in flight: a failure must
      // land in a mounted form. A scrim tap never closes it, so a stray tap on
      // the phone sheet cannot drop the reference and notes.
      dismissible={!pending}
      dismissOnScrim={false}
      finalFocus={finalFocus}
      // The `id="record-payment"` (default) stays so the payment-timeline
      // empty state (`href="#record-payment"`) scrolls to the trigger.
      trigger={
        <Button
          variant={triggerVariant}
          {...(triggerSize ? { size: triggerSize } : {})}
          touchHeight
          data-testid={triggerTestId}
          id={triggerId}
          aria-label={triggerAriaLabel}
        >
          {triggerLabel ?? tDetail('actions.pay')}
        </Button>
      }
      title={t('title')}
      description={t('description')}
    >
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {documentNumber ? (
          // 088 T021c / UX — WHICH bill is being paid, so a per-row open (the
          // dialog overlays the table, losing row context) cannot mint the
          // irreversible §87 RC against the wrong invoice; with the amount
          // and the full-total note the board draws.
          <div
            className="flex flex-col gap-[var(--aura-space-1)] rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-[var(--aura-space-4)] py-[var(--aura-space-3)] text-sm"
            data-testid="record-payment-document"
          >
            <p className="font-medium text-[var(--aura-fg-primary)]">
              {memberName
                ? t('payingForDocumentMember', { number: documentNumber, member: memberName })
                : t('payingForDocument', { number: documentNumber })}
            </p>
            {totalDisplay ? (
              <>
                <p className="flex flex-wrap items-baseline justify-between gap-x-4">
                  {/* The invoice's total, not what arrived: an event buyer may withhold 3% WHT. */}
                  <span className="text-[var(--aura-fg-secondary)]">{t('invoiceTotal')}</span>
                  <span className="font-semibold tabular-nums text-[var(--aura-fg-primary)]">{totalDisplay}</span>
                </p>
                <p className="text-xs text-[var(--aura-fg-secondary)]">{t('fullTotalNote')}</p>
              </>
            ) : null}
          </div>
        ) : null}
        <PaymentForm
          invoiceId={invoiceId}
          documentNumber={documentNumber}
          issueDate={issueDate}
          todayIso={todayIso}
          onSuccess={() => {
            closedViaSuccessRef.current = true;
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
          onPendingChange={setPending}
        />
      </div>
    </Dialog>
  );
}

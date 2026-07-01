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

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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
   * 088 T021c / FR-035 — optional trigger overrides so the SAME money-mutation
   * dialog can be reused as a compact per-row "Record payment" quick action on
   * the invoice list (issued / overdue bills), not only as the full-size
   * primary CTA on the detail page. Defaults reproduce the detail-page trigger
   * byte-for-byte, so the detail call site needs no change.
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
  readonly triggerVariant?: React.ComponentProps<typeof Button>['variant'];
  readonly triggerSize?: React.ComponentProps<typeof Button>['size'];
  readonly triggerClassName?: string;
  readonly triggerId?: string;
  readonly triggerTestId?: string;
};

export function RecordPaymentDialog({
  invoiceId,
  documentNumber,
  issueDate,
  todayIso,
  triggerLabel,
  triggerAriaLabel,
  triggerVariant = 'default',
  triggerSize,
  triggerClassName,
  triggerId = 'record-payment',
  triggerTestId = 'record-payment-trigger',
}: Props) {
  const t = useTranslations('admin.invoices.pay');
  const tDetail = useTranslations('admin.invoices.detail');
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* H-14 (review 2026-04-27): compose via Base-UI `render` prop
        * so the trigger inherits the Button primitive's focus-ring +
        * cursor + disabled-state guarantees instead of using raw
        * `buttonVariants()`. The `id="record-payment"` (default) stays so the
        * empty-state CTA in payment-timeline.tsx
        * (`href="#record-payment"`) scrolls + focuses the trigger. */}
      <DialogTrigger
        render={
          <Button
            variant={triggerVariant}
            size={triggerSize}
            className={triggerClassName}
            data-testid={triggerTestId}
            id={triggerId}
            aria-label={triggerAriaLabel}
          >
            {triggerLabel ?? tDetail('actions.pay')}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
          {documentNumber ? (
            // 088 T021c / UX — surface WHICH bill is being paid so a per-row
            // open (the dialog overlays the table, losing row context) cannot
            // mint the irreversible §87 RC against the wrong invoice. Rendered
            // whenever a number is in scope (the detail page passes it too — a
            // benign echo of the number already visible behind the overlay).
            <p
              className="text-sm font-medium text-foreground"
              data-testid="record-payment-document"
            >
              {t('payingForDocument', { number: documentNumber })}
            </p>
          ) : null}
        </DialogHeader>
        <PaymentForm
          invoiceId={invoiceId}
          documentNumber={documentNumber}
          issueDate={issueDate}
          todayIso={todayIso}
          onSuccess={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

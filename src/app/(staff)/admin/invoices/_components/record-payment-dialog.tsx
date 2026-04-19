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
import { buttonVariants } from '@/components/ui/button';
import { PaymentForm } from './payment-form';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string | null;
  readonly issueDate: string | null;
};

export function RecordPaymentDialog({ invoiceId, documentNumber, issueDate }: Props) {
  const t = useTranslations('admin.invoices.pay');
  const tDetail = useTranslations('admin.invoices.detail');
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={buttonVariants({ variant: 'default' })}>
        {tDetail('actions.pay')}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <PaymentForm
          invoiceId={invoiceId}
          documentNumber={documentNumber}
          issueDate={issueDate}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

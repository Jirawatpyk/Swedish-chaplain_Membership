'use client';

/**
 * F4 UX flow refactor — Issue invoice as AlertDialog.
 *
 * Replaces the previous `/admin/invoices/[id]/issue` full-page route with an
 * in-context AlertDialog triggered from the invoice detail page. Aligns with
 * the project's destructive-action pattern (F3 archive-member, F2 clone-year,
 * F1 idle-warning).
 *
 * Why AlertDialog (not Dialog): issue pins an IMMUTABLE tax snapshot — under
 * the 088 flow a non-§87 ใบแจ้งหนี้ (bill) number is allocated at issue and the
 * §86/4 tax receipt (RC §87 number) is minted only at payment; either way,
 * correcting the document requires a void. AlertDialog forces explicit
 * acknowledgement (Cancel + Continue are prominent, ESC/overlay = Cancel).
 *
 * 088 US8 (UX-A) split — the dialog BODY (summary + the `vat_treatment`
 * control + MFA-cert fields + FR-027 review + typed-phrase gate + POST) lives
 * in `<IssueInvoiceForm>`, which renders inside the open Popup. This wrapper
 * owns only the trigger + open state, mirroring the RefundDialog/RefundForm
 * split so the form is RTL-testable without the Base-UI-dialog jsdom hang.
 * Because the Popup unmounts on close, the form's transient state (typed
 * phrase, vat_treatment, cert fields) resets automatically each open.
 *
 * a11y: `AlertDialogTitle` is the accessible name; `AlertDialogDescription`
 * carries the immutable-snapshot acknowledgement; the summary + review are
 * inside the dialog body so SR users receive the numbers + warnings as part of
 * the dialog content.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { IssueInvoiceForm, type IssueInvoiceFormProps } from './issue-invoice-form';

type Props = Omit<IssueInvoiceFormProps, 'onClose'>;

export function IssueInvoiceDialog(props: Props) {
  const t = useTranslations('admin.invoices.issue');
  const tDetail = useTranslations('admin.invoices.detail');
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger className={buttonVariants({ variant: 'default' })}>
        {tDetail('actions.issue')}
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {props.taxAtPayment
              ? t('review.immutableSnapshotAck')
              : t('irreversibleWarning')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <IssueInvoiceForm {...props} onClose={() => setOpen(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

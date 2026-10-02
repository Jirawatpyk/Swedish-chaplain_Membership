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
 * split so the form is RTL-testable on its own.
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
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { IssueInvoiceForm, type IssueInvoiceFormProps } from './issue-invoice-form';

type Props = Omit<IssueInvoiceFormProps, 'onClose' | 'onPendingChange'>;

/**
 * Spec 122 US8b (T825) — AURA `Dialog role="alertdialog"`: its title names
 * it and the acknowledgement describes it; the form below carries its own
 * Cancel (first focus) and Issue. While the POST runs, Escape and the scrim
 * do nothing, so a failure lands in a mounted form.
 */
export function IssueInvoiceDialog(props: Props) {
  const t = useTranslations('admin.invoices.issue');
  const tDetail = useTranslations('admin.invoices.detail');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <Dialog
      role="alertdialog"
      size="lg"
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      dismissible={!pending}
      trigger={
        <Button variant="primary" touchHeight>
          {tDetail('actions.issue')}
        </Button>
      }
      title={t('title')}
      description={props.taxAtPayment ? t('review.immutableSnapshotAck') : t('irreversibleWarning')}
    >
      {/* The panel unmounts on close, so the typed phrase, treatment and
          certificate fields start fresh on every open. */}
      <IssueInvoiceForm {...props} onClose={() => setOpen(false)} onPendingChange={setPending} />
    </Dialog>
  );
}

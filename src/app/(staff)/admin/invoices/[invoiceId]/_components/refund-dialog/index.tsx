'use client';

/**
 * T113 — RefundDialog shell (F5 Phase 6 / US4 / FR-029).
 *
 * Composition: AURA `Dialog role="alertdialog"` (spec 122 US8b) — the
 * trigger renders a danger-secondary button (T112) inline; the panel
 * hosts the title + description, the invoice and receipt references and
 * `<RefundForm>`, whose Cancel takes the first focus.
 * Cancel button is the default-focused element (FR-029(d) —
 * destructive defaults to safe action). Confirm button shows a
 * spinner while the request is in flight (FR-029(e) — visual
 * processing indicator).
 *
 * Auto-open path (T118): when the URL carries `?refund=1`, the
 * dialog mounts open. The cmdk "Issue refund" command navigates to
 * `/admin/invoices/[id]?refund=1` so admins can refund without
 * leaving the keyboard.
 */
import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { RefundForm } from './refund-form';

type Props = {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly memberCompanyName: string;
  readonly remainingRefundableSatang: bigint;
  readonly currencyCode: string;
  /** 0306 — see RefundForm: a full MEMBERSHIP refund asks Keep / End. */
  readonly invoiceSubject: 'membership' | 'event';
  /** 0306 — the invoice's un-credited headroom (`total − credited`). */
  readonly invoiceHeadroomSatang: bigint;
  /**
   * Receipt document number (e.g. `RC-2026-0001`) — surfaced in the
   * dialog header so the bookkeeper can cross-reference the refund
   * against the receipt without leaving the modal. NULL on combined-
   * mode invoices (receipt reuses invoice number) — handled at
   * render time.
   */
  readonly receiptDocumentNumberRaw?: string | null;
  /** Invoice document number — shown alongside receipt for context. */
  readonly invoiceDocumentNumber?: string | null;
  /**
   * Gap E (2026-07-12) — a NON-terminal (pending/async) refund already
   * exists for this payment. `computeRemainingRefundable` intentionally
   * does NOT subtract pending amounts (a pending refund can still FAIL and
   * re-open the balance), so the button is gated on pending-EXISTENCE
   * instead: while true, the trigger is disabled and shows a "settling"
   * affordance. A later failure clears the flag and re-enables it.
   */
  readonly pendingRefundExists?: boolean;
};

export function RefundDialog({
  paymentId,
  invoiceId,
  memberCompanyName,
  remainingRefundableSatang,
  currencyCode,
  invoiceSubject,
  invoiceHeadroomSatang,
  receiptDocumentNumberRaw,
  invoiceDocumentNumber,
  pendingRefundExists = false,
}: Props) {
  const t = useTranslations('admin.refund');
  const tDialog = useTranslations('admin.refund.dialog');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Auto-open when ?refund=1 query param is present (T118 cmdk
  // selection path: command palette navigates to
  // /admin/invoices/[id]?refund=1 → dialog opens automatically). Never
  // auto-open while a refund is settling (Gap E — the trigger is disabled).
  const [open, setOpen] = useState(
    !pendingRefundExists && searchParams.get('refund') === '1',
  );
  const [submitting, setSubmitting] = useState(false);

  // Clear the `?refund=1` query param (preserving any other params) so a
  // refresh / shared link does not reopen the dialog. `router.replace`
  // keeps history clean (no extra entry).
  const stripRefundParam = useCallback(() => {
    if (searchParams.get('refund') !== '1') return;
    const params = new URLSearchParams(searchParams);
    params.delete('refund');
    const qs = params.toString();
    router.replace(`/admin/invoices/${invoiceId}${qs ? `?${qs}` : ''}`, {
      scroll: false,
    });
  }, [searchParams, router, invoiceId]);

  // CF-3 (2026-07-12) — consume the auto-open intent once, on mount: the
  // `open` initializer above already captured `?refund=1`, so removing the
  // param here never closes the dialog — it just stops a hard reload from
  // re-opening it and keeps a stale param out of shared/bookmarked URLs.
  // Also covers the pending-gate branch below (dialog stays closed, but the
  // dead `?refund=1` param is still cleared).
  useEffect(() => {
    stripRefundParam();
  }, [stripRefundParam]);

  // Defence-in-depth: also clear on close (no-op if the mount effect already
  // stripped it).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) stripRefundParam();
    },
    [stripRefundParam],
  );

  // Gap E — a refund is settling: disable the trigger + surface a "settling"
  // affordance instead of the active dialog. Hooks above run unconditionally
  // (rules-of-hooks); the branch is a prop-driven render fork.
  if (pendingRefundExists) {
    return (
      // On a phone the hint stays the trigger's description but is not drawn,
      // so the action bar stays one row; the label already says it settles.
      <div className="flex flex-col items-start gap-1 sm:items-end max-sm:items-stretch">
        <Button
          variant="danger-secondary"
          touchHeight
          disabled
          aria-describedby="refund-settling-hint"
          data-testid="refund-dialog-trigger"
        >
          {t('button.settlingLabel')}
        </Button>
        <p id="refund-settling-hint" className="max-w-xs text-xs text-[var(--aura-fg-secondary)] max-sm:sr-only">
          {t('button.settlingHint')}
        </p>
      </div>
    );
  }

  return (
    <Dialog
      role="alertdialog"
      open={open}
      onOpen={() => handleOpenChange(true)}
      onClose={() => handleOpenChange(false)}
      // No Escape while the refund is being sent: its outcome must land in a
      // mounted form.
      dismissible={!submitting}
      trigger={
        <Button
          variant="danger-secondary"
          touchHeight
          aria-label={t('button.ariaLabel')}
          data-testid="refund-dialog-trigger"
        >
          {t('button.label')}
        </Button>
      }
      title={tDialog('title')}
      description={tDialog('description')}
    >
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {/* §87 cross-reference — the invoice and receipt numbers the refund
            applies to. Combined-mode rows have a NULL receiptDocumentNumberRaw
            → fall back to invoiceDocumentNumber with a "(combined)" hint. */}
        {(invoiceDocumentNumber || receiptDocumentNumberRaw) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[var(--aura-fg-secondary)]">
            {invoiceDocumentNumber && (
              <>
                <dt>{tDialog('refsInvoice')}</dt>
                <dd className="font-mono tabular-nums">{invoiceDocumentNumber}</dd>
              </>
            )}
            <dt>{tDialog('refsReceipt')}</dt>
            <dd className="font-mono tabular-nums">
              {receiptDocumentNumberRaw ?? (
                <span>
                  {invoiceDocumentNumber} <span className="text-xs">({tDialog('refsCombinedHint')})</span>
                </span>
              )}
            </dd>
          </dl>
        )}
        <RefundForm
          paymentId={paymentId}
          memberCompanyName={memberCompanyName}
          remainingRefundableSatang={remainingRefundableSatang}
          currencyCode={currencyCode}
          invoiceSubject={invoiceSubject}
          invoiceHeadroomSatang={invoiceHeadroomSatang}
          onClose={() => handleOpenChange(false)}
          onPendingChange={setSubmitting}
        />
      </div>
    </Dialog>
  );
}

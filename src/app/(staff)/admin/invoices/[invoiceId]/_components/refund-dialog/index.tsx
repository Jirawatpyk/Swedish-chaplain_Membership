'use client';

/**
 * T113 — RefundDialog shell (F5 Phase 6 / US4 / FR-029).
 *
 * Composition: shadcn `<AlertDialog>` (per spec § anatomy) — the
 * trigger renders a destructive-outline button (T112) inline; the
 * content hosts the bilingual title + description + `<RefundForm>`.
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
import { useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { RefundForm } from './refund-form';

type Props = {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly memberCompanyName: string;
  readonly remainingRefundableSatang: bigint;
  readonly currencyCode: string;
};

export function RefundDialog({
  paymentId,
  invoiceId,
  memberCompanyName,
  remainingRefundableSatang,
  currencyCode,
}: Props) {
  const t = useTranslations('admin.refund');
  const tDialog = useTranslations('admin.refund.dialog');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Auto-open when ?refund=1 query param is present (T118 cmdk
  // selection path: command palette navigates to
  // /admin/invoices/[id]?refund=1 → dialog opens automatically).
  const [open, setOpen] = useState(searchParams.get('refund') === '1');

  // On close: clear the `?refund=1` query param so a refresh / shared
  // link does not reopen the dialog. `router.replace` keeps history
  // clean (no extra entry).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next && searchParams.get('refund') === '1') {
        const params = new URLSearchParams(searchParams);
        params.delete('refund');
        const qs = params.toString();
        router.replace(`/admin/invoices/${invoiceId}${qs ? `?${qs}` : ''}`, {
          scroll: false,
        });
      }
    },
    [searchParams, router, invoiceId],
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      {/* R003: render the Trigger via the project's `<Button>` primitive
          so the destructive-outline trigger inherits the shared focus-
          ring + cursor + disabled-state styling from `ux-standards.md`
          § 11 instead of just the `buttonVariants` class shape. Base
          UI's `render` prop is the equivalent of Radix's `asChild`. */}
      <AlertDialogTrigger
        render={<Button variant="destructive-outline" />}
        aria-label={t('button.ariaLabel')}
        data-testid="refund-dialog-trigger"
      >
        {t('button.label')}
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{tDialog('title')}</AlertDialogTitle>
          <AlertDialogDescription>{tDialog('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <RefundForm
          paymentId={paymentId}
          invoiceId={invoiceId}
          memberCompanyName={memberCompanyName}
          remainingRefundableSatang={remainingRefundableSatang}
          currencyCode={currencyCode}
          onClose={() => handleOpenChange(false)}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

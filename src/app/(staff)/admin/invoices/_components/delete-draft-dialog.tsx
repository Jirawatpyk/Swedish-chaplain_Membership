'use client';

/**
 * Delete-draft confirmation dialog (F4 FR-001 — "A draft … can be
 * deleted without an audit footprint on the tax-document sequence").
 *
 * Draft delete is NOT in FR-040's typed-phrase list (that covers
 * Issue / Void / Credit only — actions that consume sequence numbers
 * or create tax documents). Drafts allocate nothing, so a single
 * AlertDialog confirm is sufficient — matches the "low-stakes
 * destructive" pattern and avoids needless friction on iteration.
 *
 * After success: redirect to /admin/invoices (the detail URL no
 * longer resolves) + toast.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

type Props = {
  readonly invoiceId: string;
};

/**
 * Spec 122 US8b (T825) — on AURA through the shared `ConfirmationDialog`
 * (`role="alertdialog"`, focus on Cancel). It stays open on a failure, so the
 * admin reads the error toast with the draft still in front of them.
 */
export function DeleteDraftDialog({ invoiceId }: Props) {
  const t = useTranslations('admin.invoices.deleteDraft');
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function confirm() {
    const res = await fetch(`/api/invoices/${invoiceId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const code = (body as { error?: { code?: string } })?.error?.code;
      toast.error(t('errors.failed'), {
        description: code ? t('errors.codeFallback', { code }) : t('errors.unknown'),
      });
      return;
    }
    toast.success(t('success'));
    setOpen(false);
    router.push('/admin/invoices');
    router.refresh();
  }

  return (
    <>
      <Button variant="danger-secondary" touchHeight onClick={() => setOpen(true)}>
        {t('trigger')}
      </Button>
      <ConfirmationDialog
        open={open}
        onOpenChange={setOpen}
        title={t('title')}
        description={t('description')}
        cancelLabel={t('cancel')}
        confirmLabel={t('deleteButton')}
        destructive
        closeOnConfirm={false}
        onConfirm={confirm}
      />
    </>
  );
}

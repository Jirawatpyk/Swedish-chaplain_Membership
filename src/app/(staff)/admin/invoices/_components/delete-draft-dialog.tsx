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

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

type Props = {
  readonly invoiceId: string;
};

export function DeleteDraftDialog({ invoiceId }: Props) {
  const t = useTranslations('admin.invoices.deleteDraft');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
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
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        className={buttonVariants({ variant: 'destructive-outline' })}
      >
        {t('trigger')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={pending}
            aria-busy={pending}
            className={buttonVariants({ variant: 'destructive' })}
          >
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {pending ? t('deleting') : t('deleteButton')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

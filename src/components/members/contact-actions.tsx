'use client';

/**
 * Per-contact action cluster on the member detail page.
 *
 *   - Edit    → opens ContactFormDialog (PATCH contact fields)
 *   - Promote → POST /contacts/[id]/promote-primary (secondary contacts only)
 *   - Remove  → DELETE /contacts/[id] (secondary contacts only; the API
 *               refuses to remove a primary)
 *
 * Promote + Remove are hidden for the primary contact: you cannot remove a
 * primary (must promote another first) and promoting the current primary is
 * a no-op.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { PencilIcon, Trash2Icon, StarIcon, Loader2Icon } from 'lucide-react';
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
import { Button, buttonVariants } from '@/components/ui/button';
import {
  ContactFormDialog,
  type ContactInitial,
} from './contact-form-dialog';

type Props = {
  readonly memberId: string;
  readonly contact: ContactInitial;
  readonly isPrimary: boolean;
};

export function ContactActions({ memberId, contact, isPrimary }: Props) {
  const t = useTranslations('admin.members.detail.contactActions');
  const router = useRouter();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const contactName = `${contact.firstName} ${contact.lastName}`.trim();

  const handleError = async (res: Response): Promise<void> => {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    if (res.status === 409) {
      toast.error(t('errors.conflict'));
    } else if (res.status === 404) {
      toast.error(t('errors.notFound'));
    } else {
      toast.error(t('errors.generic'));
    }
    void body;
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/members/${memberId}/contacts/${contact.contactId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        await handleError(res);
        return;
      }
      toast.success(t('removeSuccess'));
      setRemoveOpen(false);
      router.refresh();
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const handlePromote = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/members/${memberId}/contacts/${contact.contactId}/promote-primary`,
        { method: 'POST' },
      );
      if (!res.ok) {
        await handleError(res);
        return;
      }
      toast.success(t('promoteSuccess'));
      setPromoteOpen(false);
      router.refresh();
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ContactFormDialog
        memberId={memberId}
        mode="edit"
        contact={contact}
        trigger={
          <Button type="button" variant="outline" size="sm" className="gap-2">
            <PencilIcon className="size-4" aria-hidden="true" />
            {t('edit')}
          </Button>
        }
      />

      {!isPrimary && (
        <>
          <AlertDialog open={promoteOpen} onOpenChange={setPromoteOpen}>
            <AlertDialogTrigger
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <StarIcon className="size-4" aria-hidden="true" />
              {t('promote')}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('promoteTitle', { name: contactName })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('promoteDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy} autoFocus>
                  {t('cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handlePromote();
                  }}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy && (
                    <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  )}
                  {t('promoteConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
            <AlertDialogTrigger
              className={buttonVariants({ variant: 'destructive-outline', size: 'sm' })}
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              {t('remove')}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('removeTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('removeDescription', { name: contactName })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy} autoFocus>
                  {t('cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handleRemove();
                  }}
                  disabled={busy}
                  aria-busy={busy}
                  variant="destructive"
                >
                  {busy && (
                    <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  )}
                  {t('removeConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

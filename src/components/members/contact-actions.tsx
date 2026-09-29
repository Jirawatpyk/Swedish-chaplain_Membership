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
 *
 * Spec 122 US5b-1 (board `Admin-member-detail`): Edit and "Make primary" are
 * visible buttons, Remove sits in the row's "⋯" menu, and both confirmations
 * are the shared AURA `ConfirmationDialog`.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PencilIcon, StarIcon } from 'lucide-react';
import { DropdownMenu, IconButton, buttonClass } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
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

  const contactName = `${contact.firstName} ${contact.lastName}`.trim();

  // Promote/Remove failures aren't code-discriminated (unlike the
  // contact-form dialog's 409 email-taken case), so the response body is
  // never read — map purely on status. Keep it sync; no body parse.
  const handleError = (res: Response): void => {
    if (res.status === 409) {
      toast.error(t('errors.conflict'));
    } else if (res.status === 404) {
      toast.error(t('errors.notFound'));
    } else {
      toast.error(t('errors.generic'));
    }
  };

  // ConfirmationDialog shows the busy state and blocks a second click.
  const handleRemove = async () => {
    try {
      const res = await fetch(
        `/api/members/${memberId}/contacts/${contact.contactId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        handleError(res);
        return;
      }
      toast.success(t('removeSuccess'));
      setRemoveOpen(false);
      router.refresh();
    } catch {
      toast.error(t('errors.generic'));
    }
  };

  const handlePromote = async () => {
    try {
      const res = await fetch(
        `/api/members/${memberId}/contacts/${contact.contactId}/promote-primary`,
        { method: 'POST' },
      );
      if (!res.ok) {
        handleError(res);
        return;
      }
      toast.success(t('promoteSuccess'));
      setPromoteOpen(false);
      router.refresh();
    } catch {
      toast.error(t('errors.generic'));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
      <ContactFormDialog
        memberId={memberId}
        mode="edit"
        // `isPrimary` is the authoritative prop here — thread it onto the
        // ContactInitial so the dialog can keep a linked PRIMARY email
        // read-only while letting a linked SECONDARY email be edited.
        contact={{ ...contact, isPrimary }}
        trigger={
          <button type="button" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <PencilIcon className="size-4" aria-hidden="true" />
            {t('edit')}
            {/* Several contacts each have an Edit: the name tells them apart. */}
            <span className="sr-only">{`, ${contactName}`}</span>
          </button>
        }
      />

      {!isPrimary && (
        <>
          <button
            type="button"
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
            onClick={() => setPromoteOpen(true)}
          >
            <StarIcon className="size-4" aria-hidden="true" />
            {t('promote')}
            <span className="sr-only">{`, ${contactName}`}</span>
          </button>
          <DropdownMenu
            label={t('moreActions', { name: contactName })}
            trigger={<IconButton icon="ellipsis" size="sm" label={t('moreActions', { name: contactName })} />}
            items={[{ label: t('remove'), icon: 'trash-2', tone: 'danger', onSelect: () => setRemoveOpen(true) }]}
          />

          <ConfirmationDialog
            open={promoteOpen}
            onOpenChange={setPromoteOpen}
            title={t('promoteTitle', { name: contactName })}
            description={t('promoteDescription')}
            confirmLabel={t('promoteConfirm')}
            cancelLabel={t('cancel')}
            // Closes itself on success; a refusal keeps it open, as before.
            closeOnConfirm={false}
            onConfirm={handlePromote}
          />
          <ConfirmationDialog
            open={removeOpen}
            onOpenChange={setRemoveOpen}
            title={t('removeTitle')}
            description={t('removeDescription', { name: contactName })}
            confirmLabel={t('removeConfirm')}
            cancelLabel={t('cancel')}
            destructive
            closeOnConfirm={false}
            onConfirm={handleRemove}
          />
        </>
      )}
    </div>
  );
}

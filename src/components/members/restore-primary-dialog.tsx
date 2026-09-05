'use client';

/**
 * 108 T039 (US2 / FR-014) — "choose a primary contact to restore".
 *
 * Opened by `ArchivedBanner` when POST /undelete answers 409
 * `no_primary_contact`. The server sends the member's live contacts in
 * `details.designatable`; the admin picks one and the banner re-posts with
 * `designate_primary_contact_id`, so the restore and the designation commit
 * together (or not at all). Nothing is pre-selected: auto-picking a contact
 * would silently choose who receives the member's receipts (research R4/R5).
 *
 * With zero live contacts there is nothing to choose and no restore button —
 * only the add-contact door, which the member page otherwise hides for an
 * archived member. After adding, the admin restores again and the new contact
 * is offered. `finalFocus` returns focus to the banner's Restore button on
 * close (memory: AlertDialog is mounted as a SIBLING, one instance, so Base UI
 * runs its close cycle).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2Icon, UserPlusIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ContactFormDialog } from '@/components/members/contact-form-dialog';

export type DesignatableContact = {
  readonly contactId: string;
  readonly firstName: string;
  readonly lastName: string;
};

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly memberId: string;
  readonly designatable: ReadonlyArray<DesignatableContact>;
  readonly onConfirm: (contactId: string) => void;
  readonly submitting: boolean;
  /** Focus-return target on close (the banner's Restore button). */
  readonly finalFocus?: () => HTMLElement | null;
};

export function RestorePrimaryDialog({
  open,
  onOpenChange,
  memberId,
  designatable,
  onConfirm,
  submitting,
  finalFocus,
}: Props) {
  const t = useTranslations('admin.members.undelete.designate');
  const [picked, setPicked] = useState<string | null>(null);
  // Derived, not synced: a fresh list (the dialog re-opened after a lost race)
  // must not keep a choice that is no longer offered, and a stale pick must
  // never be what gets submitted.
  const selected =
    picked !== null && designatable.some((c) => c.contactId === picked) ? picked : null;
  const setSelected = setPicked;

  const none = designatable.length === 0;
  const canConfirm = selected !== null && !submitting;

  const handleClose = () => {
    setSelected(null);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : handleClose())}>
      <AlertDialogContent finalFocus={finalFocus} data-testid="restore-primary-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {none ? t('noContactsDescription') : t('description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {none ? (
          <ContactFormDialog
            memberId={memberId}
            mode="add"
            trigger={
              <Button
                type="button"
                variant="outline"
                className="w-fit gap-2"
                data-testid="restore-primary-add-contact"
              >
                <UserPlusIcon className="size-4" aria-hidden="true" />
                {t('addContact')}
              </Button>
            }
          />
        ) : (
          <fieldset className="flex flex-col gap-3" disabled={submitting}>
            <legend className="text-sm font-medium">{t('contactsLabel')}</legend>
            <RadioGroup
              value={selected ?? ''}
              onValueChange={(v) => setSelected(typeof v === 'string' && v !== '' ? v : null)}
              aria-label={t('contactsLabel')}
            >
              {designatable.map((c) => {
                const id = `designate-${c.contactId}`;
                return (
                  <div key={c.contactId} className="flex items-center gap-3">
                    <RadioGroupItem
                      id={id}
                      value={c.contactId}
                      disabled={submitting}
                      aria-label={`${c.firstName} ${c.lastName}`}
                    />
                    <Label htmlFor={id} className="cursor-pointer font-normal">
                      {c.firstName} {c.lastName}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          </fieldset>
        )}

        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={submitting}
            data-testid="restore-primary-cancel"
          >
            {t('cancel')}
          </Button>
          {none ? null : (
            <Button
              type="button"
              onClick={() => {
                if (selected !== null) onConfirm(selected);
              }}
              disabled={!canConfirm}
              data-testid="restore-primary-confirm"
            >
              {submitting ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t('confirm')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

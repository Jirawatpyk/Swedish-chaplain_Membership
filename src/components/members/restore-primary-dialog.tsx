'use client';

/**
 * 108 T039 (US2 / FR-014) — "choose a primary contact before restoring".
 *
 * Opened by `ArchivedBanner` when POST /undelete answers 409
 * `no_primary_contact`. The server sends the member's live contacts in
 * `details.designatable`; the admin picks one and the banner re-posts with
 * `designate_primary_contact_id`, so the restore and the designation commit
 * together (or not at all). Nothing is pre-selected: auto-picking a contact
 * would silently choose who receives the member's receipts (research R4/R5).
 * Each choice shows the email, because that IS the question being asked.
 *
 * With zero live contacts there is nothing to choose and no restore button —
 * only the add-contact door (the member page hides "Add contact" for an
 * archived member). `addContact` makes the first contact of a member with no
 * live primary the primary, so after a save the banner restores again in
 * place and succeeds; the admin never has to find the Restore button twice.
 *
 * A lost race (the chosen contact vanished under us) is announced INSIDE the
 * dialog as `role="alert"`: a toast would sit behind the modal's aria-hidden
 * and never reach a screen reader (ux-standards §6.4).
 *
 * `finalFocus` returns focus to a surviving element on close (the banner
 * decides which — the Restore button on cancel, the page landmark on success,
 * since the banner itself unmounts on refresh). Mounted as ONE sibling
 * instance so Base UI runs its close cycle.
 *
 * Initial focus lands on the first radio, not on Cancel (a deliberate
 * deviation from ux-standards §6.2): the action is non-destructive, nothing
 * is pre-selected, Tab never selects a Base UI radio, and the confirm button
 * stays disabled until a pick — so the first thing focus should reach is the
 * choice.
 */

import { useId, useState } from 'react';
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
  readonly email: string;
};

/** Why the dialog re-opened with a different list than the admin last saw. */
export type RestorePrimaryNotice = 'contact_gone' | 'contact_gone_none';

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fires after the close animation completes (Base UI `onOpenChangeComplete`). */
  readonly onCloseComplete?: () => void;
  readonly memberId: string;
  readonly designatable: ReadonlyArray<DesignatableContact>;
  readonly notice?: RestorePrimaryNotice | null;
  readonly onConfirm: (contactId: string) => void;
  /** Zero-contacts door: the add-contact dialog saved a new contact. */
  readonly onContactAdded?: () => void;
  readonly submitting: boolean;
  /** Focus-return target on close. */
  readonly finalFocus?: () => HTMLElement | null;
};

export function RestorePrimaryDialog({
  open,
  onOpenChange,
  onCloseComplete,
  memberId,
  designatable,
  notice = null,
  onConfirm,
  onContactAdded,
  submitting,
  finalFocus,
}: Props) {
  const t = useTranslations('admin.members.undelete.designate');
  const legendId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  // Derived, not synced: a fresh list (the dialog re-opened after a lost race)
  // must not keep a choice that is no longer offered, and a stale pick must
  // never be what gets submitted.
  const selected =
    picked !== null && designatable.some((c) => c.contactId === picked) ? picked : null;

  const none = designatable.length === 0;
  const canConfirm = selected !== null && !submitting;

  const handleClose = () => {
    setPicked(null);
    onOpenChange(false);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
          return;
        }
        // Escape / outside press must not abandon a restore that is in
        // flight — its 409 or success would land on a closed dialog.
        if (submitting) return;
        handleClose();
      }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        // Every close path ends here — Cancel/Escape AND the banner flipping
        // `open` after a failed or successful restore. The component stays
        // mounted, so the pick is forgotten HERE, not only in `handleClose`:
        // a re-opened dialog (the next 409) must start with nothing chosen
        // (T041 round 3, L2).
        setPicked(null);
        onCloseComplete?.();
      }}
    >
      <AlertDialogContent
        finalFocus={finalFocus}
        className="max-h-[85vh] overflow-y-auto"
        data-testid="restore-primary-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {none ? t('noContactsDescription') : t('description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {notice === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {notice === 'contact_gone_none' ? t('retryNone') : t('retry')}
          </p>
        )}

        {none ? null : (
          <fieldset className="flex flex-col gap-3" disabled={submitting}>
            <legend id={legendId} className="text-sm font-medium">
              {t('contactsLabel')}
            </legend>
            <RadioGroup
              value={selected ?? ''}
              onValueChange={(v) => setPicked(typeof v === 'string' && v !== '' ? v : null)}
              aria-labelledby={legendId}
              // The LIST scrolls, not the dialog: with five contacts and the
              // Thai description on a 320×568 viewport the footer must stay
              // pinned and reachable (T041 UX round 2, N5). The dialog's own
              // max-h is the safety net.
              className="max-h-[40vh] overflow-y-auto"
            >
              {designatable.map((c) => {
                const id = `designate-${c.contactId}`;
                return (
                  <div key={c.contactId} className="flex items-start gap-3">
                    <RadioGroupItem
                      id={id}
                      value={c.contactId}
                      disabled={submitting}
                      className="mt-0.5"
                    />
                    <Label htmlFor={id} className="mb-0 flex cursor-pointer flex-col gap-0.5 font-normal">
                      <span>
                        {c.firstName} {c.lastName}
                      </span>
                      <span className="text-xs text-muted-foreground">{c.email}</span>
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
          {none ? (
            <ContactFormDialog
              memberId={memberId}
              mode="add"
              description={t('addContactDescription')}
              disabled={submitting}
              {...(onContactAdded ? { onSaved: onContactAdded } : {})}
              trigger={
                // While the retry restore is in flight this is the only
                // enabled control and the nested form's return-focus target.
                // `disabled` would make it untabbable and drop that focus on
                // <body>; aria-disabled keeps it focusable and inert (T041 UX
                // round 2, N2).
                <Button
                  type="button"
                  className="gap-2"
                  aria-disabled={submitting}
                  data-testid="restore-primary-add-contact"
                >
                  {submitting ? (
                    <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlusIcon className="size-4" aria-hidden="true" />
                  )}
                  {submitting ? t('restoring') : t('addContact')}
                </Button>
              }
            />
          ) : (
            <Button
              type="button"
              onClick={() => {
                if (selected !== null) onConfirm(selected);
              }}
              disabled={!canConfirm}
              data-testid="restore-primary-confirm"
            >
              {submitting ? (
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {t('confirm')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

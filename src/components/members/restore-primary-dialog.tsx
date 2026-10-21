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
 * instance so its close cycle runs.
 *
 * Initial focus lands on the first radio, not on Cancel (a deliberate
 * deviation from ux-standards §6.2): the action is non-destructive, nothing
 * is pre-selected, Tab never selects a radio, and the confirm button stays
 * disabled until a pick — so the first thing focus should reach is the choice.
 *
 * Spec 122 US5b-1: an AURA `Dialog role="alertdialog"` (its body scrolls on a
 * short screen while the footer stays reachable) with an AURA `RadioGroup`
 * whose legend names the choices. On close, AURA's `finalFocus` sends focus
 * to the caller's target and `onCloseComplete` runs once the panel has left
 * the page (AURA 5.16, handoff 101).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserPlusIcon } from 'lucide-react';
import { Button, Dialog, RadioGroup } from '@jirawatpyk/aura-react';
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
  /** Fires once the dialog has closed and AURA has restored focus. */
  readonly onCloseComplete?: () => void;
  readonly memberId: string;
  readonly designatable: ReadonlyArray<DesignatableContact>;
  readonly notice?: RestorePrimaryNotice | null;
  readonly onConfirm: (contactId: string) => void;
  /** Zero-contacts door: the add-contact dialog saved a new contact. */
  readonly onContactAdded?: () => void;
  readonly submitting: boolean;
  /** Focus-return target on close. */
  readonly finalFocus?: () => HTMLElement | false | null;
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
    <Dialog
      role="alertdialog"
      open={open}
      onClose={() => {
        if (submitting) return;
        handleClose();
      }}
      dismissible={!submitting}
      finalFocus={() => finalFocus?.() || null}
      onCloseComplete={() => {
        // Forget the pick however it closed (a caller may close it itself).
        setPicked(null);
        onCloseComplete?.();
      }}
      title={t('title')}
      description={none ? t('noContactsDescription') : t('description')}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={submitting} data-testid="restore-primary-cancel">
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
                // AURA's loading state is aria-disabled, never `disabled`: the
                // nested dialog returns focus here, so it must stay focusable.
                <Button loading={submitting} data-testid="restore-primary-add-contact">
                  {!submitting && <UserPlusIcon className="size-4" aria-hidden="true" />}
                  {submitting ? t('restoring') : t('addContact')}
                </Button>
              }
            />
          ) : (
            <Button
              onClick={() => {
                if (selected !== null) onConfirm(selected);
              }}
              loading={submitting}
              disabled={!canConfirm && !submitting}
              data-testid="restore-primary-confirm"
            >
              {t('confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="restore-primary-dialog">
        {notice === null ? null : (
          <p role="alert" className="text-sm font-medium text-[var(--aura-fg-danger)]">
            {notice === 'contact_gone_none' ? t('retryNone') : t('retry')}
          </p>
        )}
        {none ? null : (
          <RadioGroup
            label={t('contactsLabel')}
            name="designate-primary"
            value={selected ?? ''}
            onChange={(v) => setPicked(v !== '' ? v : null)}
            disabled={submitting}
            // Each choice shows the email: which address receives the
            // receipts IS the question being asked.
            options={designatable.map((c) => ({
              value: c.contactId,
              label: `${c.firstName} ${c.lastName}`.trim(),
              description: c.email,
            }))}
          />
        )}
      </div>
    </Dialog>
  );
}

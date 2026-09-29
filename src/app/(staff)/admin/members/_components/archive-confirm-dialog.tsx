'use client';

/**
 * T110 — Archive confirmation dialog with typed-phrase confirmation (US4 AS3).
 *
 * When > 5 rows are selected, the admin must type the exact phrase
 * "Archive N members" to confirm the destructive action per
 * ux-standards § 4 destructive-action rules.
 *
 * Lists up to 5 company names; truncates the rest with "…and N more".
 *
 * B1 a11y fix: an alertdialog, so the destructive confirmation is announced
 * with the correct ARIA role; focus starts on Cancel per ux-standards § 6.2.
 * H7 a11y fix: spinner + disabled state while the action is pending.
 * 122 US5a (T504): on the shared AURA ConfirmationDialog.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { TextField } from '@jirawatpyk/aura-react';
import { ARCHIVE_TYPED_PHRASE_THRESHOLD } from '@/lib/members-bulk-constants';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

const TYPED_PHRASE_THRESHOLD = ARCHIVE_TYPED_PHRASE_THRESHOLD;

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly companyNames: string[];
  readonly count: number;
  readonly onConfirm: () => void | Promise<void>;
  /** H7: whether the archive action is in-flight (disables the action). */
  readonly pending?: boolean;
  /**
   * 107-auto-invoice Task 15 review (UX-1) — focus-return target on close.
   * Required here (unlike most `ConfirmationDialog` callers, where it is an
   * optional escape hatch) because this dialog's trigger lives in
   * `BulkActionBar`, whose actions all disappear on every successful archive
   * (`onClear()` → nothing selected → the ActionBar goes idle). The default
   * focus-return would target the vanished trigger and drop focus to
   * `<body>`. Build via `useDialogFinalFocus`; see the BulkActionBar module
   * header. WCAG 2.1 AA SC 2.4.3.
   */
  readonly finalFocus?: () => HTMLElement | false | null;
};

export function ArchiveConfirmDialog({
  open,
  onOpenChange,
  companyNames,
  count,
  onConfirm,
  pending = false,
  finalFocus,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const [typedPhrase, setTypedPhrase] = useState('');
  const requiresPhrase = count > TYPED_PHRASE_THRESHOLD;
  const expectedPhrase = t('archivePhrase', { count });

  // Round-2 review I-1: reset the phrase in BOTH directions (open AND close),
  // so a stale phrase after Cancel can't auto-confirm the next open.
  // H7: the dialog refuses Escape / the scrim while the archive is in flight
  // (ConfirmationDialog stops dismissal while its confirm is running).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pending) return; // block close while pending
      setTypedPhrase('');
      onOpenChange(next);
    },
    [onOpenChange, pending],
  );

  const canConfirm = requiresPhrase ? typedPhrase.trim() === expectedPhrase : true;

  const displayedNames = companyNames.slice(0, 5);
  const remainingCount = count - displayedNames.length;

  return (
    // AURA `Dialog role="alertdialog"` through ConfirmationDialog: focus
    // starts on Cancel (ux-standards § 6.2), the confirm shows a spinner while
    // the archive runs (H7).
    <ConfirmationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('archiveTitle', { count })}
      description={t('archiveDescription')}
      confirmLabel={t('confirmArchive', { count })}
      cancelLabel={t('cancel')}
      destructive
      confirmDisabled={!canConfirm || pending}
      onConfirm={onConfirm}
      {...(finalFocus ? { finalFocus } : {})}
    >
      <div className="flex flex-col gap-3">
        <ul className="list-disc pl-5 text-sm" aria-label={t('affectedMembers')}>
          {displayedNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {remainingCount > 0 && (
            <li className="text-[var(--aura-fg-secondary)]">
              {t('andMore', { count: remainingCount })}
            </li>
          )}
        </ul>

        {/* Typed-phrase confirmation for > 5 rows */}
        {requiresPhrase && (
          <TextField
            label={t('typeToConfirm', { phrase: expectedPhrase })}
            value={typedPhrase}
            onChange={(e) => setTypedPhrase(e.target.value)}
            placeholder={expectedPhrase}
            autoComplete="off"
          />
        )}
      </div>
    </ConfirmationDialog>
  );
}

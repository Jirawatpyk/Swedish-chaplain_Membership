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
 * B1 a11y fix: converted from Dialog → AlertDialog so the destructive
 * confirmation is announced with the correct ARIA role and focus is
 * correctly managed. autoFocus on Cancel per ux-standards § 6.2.
 * H7 a11y fix: Loader2 spinner + disabled state while action is pending.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { ARCHIVE_TYPED_PHRASE_THRESHOLD } from '@/lib/members-bulk-constants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buttonVariants } from '@/components/ui/button';

const TYPED_PHRASE_THRESHOLD = ARCHIVE_TYPED_PHRASE_THRESHOLD;

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly companyNames: string[];
  readonly count: number;
  readonly onConfirm: () => void;
  /** H7: whether the archive action is in-flight (shows loader, disables action). */
  readonly pending?: boolean;
};

export function ArchiveConfirmDialog({
  open,
  onOpenChange,
  companyNames,
  count,
  onConfirm,
  pending = false,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const [typedPhrase, setTypedPhrase] = useState('');
  const requiresPhrase = count > TYPED_PHRASE_THRESHOLD;
  const expectedPhrase = t('archivePhrase', { count });

  // Round-2 review I-1: reset phrase in BOTH directions (open AND close).
  // Prior impl only reset on open, which left a stale phrase after Cancel
  // that auto-confirmed the next open if admin re-used the dialog.
  // H7: guard against dismissal while action is in-flight (pending=true) —
  // the Escape key or backdrop click must not close the dialog mid-archive.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pending) return; // block close while pending
      setTypedPhrase('');
      onOpenChange(next);
    },
    [onOpenChange, pending],
  );

  const canConfirm = requiresPhrase
    ? typedPhrase.trim() === expectedPhrase
    : true;

  const displayedNames = companyNames.slice(0, 5);
  const remainingCount = count - displayedNames.length;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('archiveTitle', { count })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('archiveDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3">
          {/* Company name list */}
          <ul className="list-disc pl-5 text-sm" aria-label={t('affectedMembers')}>
            {displayedNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
            {remainingCount > 0 && (
              <li className="text-muted-foreground">
                {t('andMore', { count: remainingCount })}
              </li>
            )}
          </ul>

          {/* Typed-phrase confirmation for > 5 rows */}
          {requiresPhrase && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="archive-confirm-phrase">
                {t('typeToConfirm', { phrase: expectedPhrase })}
              </Label>
              <Input
                id="archive-confirm-phrase"
                type="text"
                value={typedPhrase}
                onChange={(e) => setTypedPhrase(e.target.value)}
                placeholder={expectedPhrase}
                autoComplete="off"
              />
            </div>
          )}
        </div>

        <AlertDialogFooter>
          {/* B1: autoFocus on Cancel per ux-standards § 6.2 — destructive
              action defaults focus to the safe choice. */}
          <AlertDialogCancel autoFocus disabled={pending} onClick={() => handleOpenChange(false)}>
            {t('cancel')}
          </AlertDialogCancel>
          {/* H7: spinner + disabled while action is in-flight. */}
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={!canConfirm || pending}
            aria-busy={pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {t('confirmArchive', { count })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

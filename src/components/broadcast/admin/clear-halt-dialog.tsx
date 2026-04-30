'use client';

/**
 * T122 — Clear-halt confirmation dialog with typed-phrase pattern.
 *
 * Mirrors F4 destructive-action convention: admin must type the
 * member's display name to confirm the clear-halt action.
 *
 * Calls `POST /api/admin/members/[id]/broadcasts-halt-clear` on confirm.
 * On 200, refresh page (server-rendered queue re-loads halted set).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ClearHaltDialogProps {
  readonly memberId: string;
  readonly memberDisplayName: string;
}

export function ClearHaltDialog({
  memberId,
  memberDisplayName,
}: ClearHaltDialogProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.clearHaltDialog');
  const tToast = useTranslations('admin.broadcasts.toast');
  const tBanner = useTranslations('admin.broadcasts.haltBanner');
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(false);
  const [phrase, setPhrase] = useState<string>('');
  const [pending, startTransition] = useTransition();

  // Review UX-C3 + UX-R2-2 (round-3): typed-phrase confirmation
  // matches when the human-visible content matches — case + leading/
  // trailing space + internal whitespace runs + punctuation are
  // normalized away. Thai/Swedish diacritics still matter (different
  // base characters → not a match) so a misspelling still blocks
  // the destructive action.
  const normalize = (s: string): string =>
    s
      .trim()
      .replace(/[\s​-‍﻿]+/g, ' ') // collapse whitespace incl. zero-width
      .replace(/[.,;:!?'"()\-—]/g, '') // strip common punctuation
      .toLowerCase();
  const phraseValid = normalize(phrase) === normalize(memberDisplayName);

  function onConfirm() {
    if (!phraseValid) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/members/${memberId}/broadcasts-halt-clear`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        if (res.ok) {
          toast.success(tToast('clearHalted'));
          setOpen(false);
          setPhrase('');
          router.refresh();
        } else {
          toast.error(tToast('error'));
        }
      } catch {
        toast.error(tToast('error'));
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        {tBanner('clearAction')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="clear-halt-phrase">
            {t('phraseLabel', { phrase: memberDisplayName })}
          </Label>
          {/* UX-C3: show the expected phrase as a copy-target so admins
              don't have to retype while squinting between fields. */}
          <code className="block rounded bg-muted px-2 py-1 text-xs font-mono">
            {memberDisplayName}
          </code>
          <Input
            id="clear-halt-phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            disabled={pending}
            autoComplete="off"
            aria-invalid={phrase.length > 0 && !phraseValid}
            aria-describedby={
              phrase.length > 0 && !phraseValid ? 'phrase-error' : undefined
            }
          />
          {phrase.length > 0 && !phraseValid ? (
            <p id="phrase-error" className="text-xs text-destructive" role="alert">
              {t('phraseError')}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!phraseValid || pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

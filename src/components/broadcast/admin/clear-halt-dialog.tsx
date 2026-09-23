'use client';

/**
 * T122 — Clear-halt confirmation dialog with typed-phrase pattern.
 *
 * Mirrors F4 destructive-action convention: admin must type the
 * member's display name to confirm the clear-halt action.
 *
 * Calls `POST /api/admin/members/[id]/broadcasts-halt-clear` on confirm.
 * On 200, refresh page (server-rendered queue re-loads halted set).
 *
 * T155 finding U3 — on that 200 the member leaves the halted set, so
 * `halt-state-banner.tsx` stops rendering THIS row and the trigger goes with
 * it. Base UI reads `finalFocus` while the trigger is still mounted, so its
 * default restore dropped focus to `<body>`. The success close lands on the
 * banner's own heading instead; Cancel / ESC keep the default, because there
 * the trigger survives. WCAG 2.1 AA SC 2.4.3.
 */
import { useRef, useState, useTransition } from 'react';
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
import {
  TypedPhraseField,
  typedPhraseMatches,
} from '@/components/shell/typed-phrase-field';
import { useSurvivingTargetFinalFocus } from '@/components/broadcast/unmounting-trigger-final-focus';

/**
 * The halt banner's `<h2>` — the element that outlives the cleared row.
 * Declared here (a client module) so the server-rendered banner can import it
 * without this dialog importing the banner.
 */
export const HALT_BANNER_HEADING_ID = 'broadcast-halt-banner-heading';

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
  // Raised on the one close path that unmounts the trigger. No reset needed:
  // that path removes this component with the row.
  const closedViaSuccessRef = useRef<boolean>(false);
  const finalFocus = useSurvivingTargetFinalFocus(
    HALT_BANNER_HEADING_ID,
    closedViaSuccessRef,
  );

  // Review UX-C3 + UX-R2-2 (round-3): case / whitespace / punctuation are
  // normalised away — the rule now lives in the shared field (F119 U35 reuses
  // it for the E-Blast cancel dialog).
  const phraseValid = typedPhraseMatches(phrase, memberDisplayName);

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
          closedViaSuccessRef.current = true;
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
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <TypedPhraseField
          id="clear-halt-phrase"
          label={t('phraseLabel', { phrase: memberDisplayName })}
          phrase={memberDisplayName}
          value={phrase}
          onChange={setPhrase}
          errorMessage={t('phraseError')}
          disabled={pending}
        />
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

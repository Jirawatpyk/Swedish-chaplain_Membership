/**
 * F8 Phase 8 T221 — `<DoneTaskDialog>` AlertDialog component.
 *
 * Admin Done CTA wraps a shadcn AlertDialog with optional outcome-note
 * textarea (≤1000 chars per Domain invariant + DB CHECK). Submit button
 * shows pending state via `useTransition`; failure surfaces inline error
 * from API. On success, parent closes dialog + calls `router.refresh()`.
 */
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

export interface DoneTaskDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (outcomeNote: string | undefined) => Promise<void>;
}

const MAX_NOTE_LENGTH = 1000;

export function DoneTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: DoneTaskDialogProps) {
  const t = useTranslations('admin.renewals.tasks.done_dialog');
  const [outcomeNote, setOutcomeNote] = useState('');
  const [isPending, startTransition] = useTransition();
  const charsRemaining = MAX_NOTE_LENGTH - outcomeNote.length;

  function handleSubmit(): void {
    startTransition(async () => {
      const trimmed = outcomeNote.trim();
      await onSubmit(trimmed.length > 0 ? trimmed : undefined);
      // Reset only on close (parent calls onOpenChange(false) on success).
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setOutcomeNote('');
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="outcome-note">{t('outcome_note_label')}</Label>
          <Textarea
            id="outcome-note"
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            placeholder={t('outcome_note_placeholder')}
            disabled={isPending}
            rows={4}
            aria-describedby="outcome-note-counter"
          />
          <p
            id="outcome-note-counter"
            className="text-right text-xs text-muted-foreground"
            aria-live="polite"
          >
            {t('chars_remaining', { count: charsRemaining })}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            aria-busy={isPending}
            onClick={handleSubmit}
          >
            {isPending && (
              <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            )}
            {isPending ? t('submitting') : t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

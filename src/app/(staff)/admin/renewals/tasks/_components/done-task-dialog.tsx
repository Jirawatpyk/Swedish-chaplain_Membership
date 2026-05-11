/**
 * F8 Phase 8 T221 — `<DoneTaskDialog>` AlertDialog component.
 *
 * Admin Done CTA wraps a shared `<TaskActionDialog>` shell (Round 5
 * HV-1 close) with optional outcome-note textarea (≤1000 chars per
 * Domain invariant + DB CHECK). On success, parent closes dialog +
 * calls `router.refresh()`.
 *
 * Round 5 I-21 close — HTML `maxLength={1000}` provides browser-
 * native enforcement so over-length input cannot reach the server
 * even if the JS slice handler is bypassed (paste, IME, automation).
 */
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TaskActionDialog } from './task-action-dialog';

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
    <TaskActionDialog
      open={open}
      onOpenChange={onOpenChange}
      onClose={() => setOutcomeNote('')}
      title={t('title')}
      description={t('description')}
      cancelLabel={t('cancel')}
      confirmLabel={t('confirm')}
      submittingLabel={t('submitting')}
      isPending={isPending}
      canSubmit
      onSubmit={handleSubmit}
    >
      <div className="grid gap-2">
        <Label htmlFor="outcome-note">{t('outcome_note_label')}</Label>
        <Textarea
          id="outcome-note"
          value={outcomeNote}
          onChange={(e) =>
            setOutcomeNote(e.target.value.slice(0, MAX_NOTE_LENGTH))
          }
          placeholder={t('outcome_note_placeholder')}
          disabled={isPending}
          rows={4}
          maxLength={MAX_NOTE_LENGTH}
          // R10 S2 close — explicit autoFocus removes reliance on
          // base-ui DOM-order focus resolution.
          autoFocus
          aria-describedby="outcome-note-counter"
        />
        {/* R10 W1 close — dropped aria-live="polite" so SR doesn't
            announce on every keystroke. The aria-describedby wiring on
            the textarea above already exposes this counter to AT on
            focus per ux-standards § 16. */}
        <p
          id="outcome-note-counter"
          className="text-right text-xs text-muted-foreground"
        >
          {t('chars_remaining', { count: charsRemaining })}
        </p>
      </div>
    </TaskActionDialog>
  );
}

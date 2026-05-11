/**
 * F8 Phase 8 T221 — `<SkipTaskDialog>` AlertDialog component.
 *
 * Admin Skip CTA wraps the shared `<TaskActionDialog>` shell (Round 5
 * HV-1 close) with a REQUIRED reason textarea (1..500 chars per Domain
 * invariant + DB CHECK + use-case zod schema).
 *
 * Round 5 I-18 close — `aria-invalid` + `aria-describedby` inline
 * error message + `role="alert"` so screen-reader users get told why
 * the submit button is disabled instead of just observing a non-
 * responsive button.
 *
 * Round 5 I-21 close — HTML `maxLength={500}` provides browser-native
 * enforcement (see done-task-dialog for rationale).
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TaskActionDialog } from './task-action-dialog';

export interface SkipTaskDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (skippedReason: string) => Promise<void>;
}

const MAX_REASON_LENGTH = 500;

export function SkipTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: SkipTaskDialogProps) {
  const t = useTranslations('admin.renewals.tasks.skip_dialog');
  const [skippedReason, setSkippedReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = skippedReason.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= MAX_REASON_LENGTH;
  const charsRemaining = MAX_REASON_LENGTH - skippedReason.length;
  const showError = touched && !isValid;

  function handleSubmit(): void {
    setTouched(true);
    if (!isValid) {
      // R6 UX-I-2 close — return focus to the textarea so SR users
      // land on the field with the inline error message after a
      // submit-without-typing attempt. Without this, focus stays on
      // the disabled Confirm button and the user has to Shift+Tab
      // back to the field manually.
      textareaRef.current?.focus();
      return;
    }
    startTransition(async () => {
      await onSubmit(trimmed);
    });
  }

  return (
    <TaskActionDialog
      open={open}
      onOpenChange={onOpenChange}
      onClose={() => {
        setSkippedReason('');
        setTouched(false);
      }}
      title={t('title')}
      description={t('description')}
      cancelLabel={t('cancel')}
      confirmLabel={t('confirm')}
      submittingLabel={t('submitting')}
      isPending={isPending}
      canSubmit={isValid}
      onSubmit={handleSubmit}
      variant="destructive"
    >
      <div className="grid gap-2">
        <Label htmlFor="skipped-reason">
          {t('reason_label')}{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
          <span className="sr-only">{t('required_marker')}</span>
        </Label>
        <Textarea
          id="skipped-reason"
          ref={textareaRef}
          value={skippedReason}
          onChange={(e) =>
            setSkippedReason(e.target.value.slice(0, MAX_REASON_LENGTH))
          }
          onBlur={() => setTouched(true)}
          placeholder={t('reason_placeholder')}
          disabled={isPending}
          rows={4}
          required
          maxLength={MAX_REASON_LENGTH}
          aria-required="true"
          aria-invalid={showError}
          aria-describedby={
            showError
              ? 'skipped-reason-error skipped-reason-counter'
              : 'skipped-reason-counter'
          }
        />
        {showError && (
          <p
            id="skipped-reason-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {t('reason_required')}
          </p>
        )}
        {/* R10 W1 close — dropped aria-live (see done-task-dialog
            for rationale; aria-describedby is the AT path). */}
        <p
          id="skipped-reason-counter"
          className="text-right text-xs text-muted-foreground"
        >
          {t('chars_remaining', { count: charsRemaining })}
        </p>
      </div>
    </TaskActionDialog>
  );
}

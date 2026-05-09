/**
 * F8 Phase 8 T221 — `<SkipTaskDialog>` AlertDialog component.
 *
 * Admin Skip CTA wraps a shadcn AlertDialog with REQUIRED reason
 * textarea (1..500 chars per Domain invariant + DB CHECK + use-case
 * zod schema). Submit disabled until reason is non-empty. Failure
 * surfaces inline error from API.
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
  const [isPending, startTransition] = useTransition();
  const trimmed = skippedReason.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= MAX_REASON_LENGTH;
  const charsRemaining = MAX_REASON_LENGTH - skippedReason.length;

  function handleSubmit(): void {
    if (!isValid) return;
    startTransition(async () => {
      await onSubmit(trimmed);
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSkippedReason('');
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
          <Label htmlFor="skipped-reason">
            {t('reason_label')}{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <Textarea
            id="skipped-reason"
            value={skippedReason}
            onChange={(e) =>
              setSkippedReason(e.target.value.slice(0, MAX_REASON_LENGTH))
            }
            placeholder={t('reason_placeholder')}
            disabled={isPending}
            rows={4}
            required
            aria-required="true"
            aria-describedby="skipped-reason-counter"
          />
          <p
            id="skipped-reason-counter"
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
            variant="destructive"
            disabled={isPending || !isValid}
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

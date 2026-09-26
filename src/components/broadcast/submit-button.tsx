'use client';

/**
 * T090 — Submit button with disabled-state derivation + 8s timeout toast.
 *
 * Disabled state computed from FR-002 preconditions surfaced by the
 * parent (subject required, body required, segment selected, no over-
 * cap recipients, etc.) — the button never independently checks these;
 * it just renders the parent's verdict.
 *
 * 8s spinner timeout (CHK053): when `submitting === true` for ≥ 8s,
 * fire a toast hinting the request is taking longer than expected.
 */
import { useEffect, useRef } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

const TIMEOUT_MS = 8000;

export interface SubmitButtonProps {
  readonly disabled: boolean;
  readonly submitting: boolean;
  readonly onClick: () => void;
  /**
   * Portal live walk U29 (WCAG 3.3.2) — the element(s) that say WHY this is
   * dimmed, space-separated, in DOM order. The parent owns the verdict, so it
   * owns the reason too. Applied only while the button is actually disabled:
   * an `aria-describedby` that always pointed somewhere would describe a
   * control that has nothing wrong with it (the U17 rule on Brand settings).
   */
  readonly blockedReasonIds?: string;
}

export function SubmitButton({
  disabled,
  submitting,
  onClick,
  blockedReasonIds,
}: SubmitButtonProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (submitting) {
      timer.current = setTimeout(() => {
        toast.info(t('toast.takingLonger'));
      }, TIMEOUT_MS);
    } else if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [submitting, t]);

  const describedBy =
    disabled && !submitting && blockedReasonIds !== undefined && blockedReasonIds !== ''
      ? blockedReasonIds
      : undefined;

  return (
    <Button
      type="button"
      data-compose-feature="submit"
      onClick={onClick}
      disabled={disabled || submitting}
      aria-busy={submitting}
      {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
    >
      {submitting ? (
        <>
          <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          {t('toast.submitting')}
        </>
      ) : (
        t('button.submit')
      )}
    </Button>
  );
}

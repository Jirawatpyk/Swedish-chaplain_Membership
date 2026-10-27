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
 *
 * 122 US12d-1 (T1234): an AURA primary Button; `loading` draws the
 * spinner and sets aria-busy; the disabled and described-by states are
 * unchanged.
 */
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button } from '@jirawatpyk/aura-react';

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
      variant="primary"
      data-compose-feature="submit"
      onClick={onClick}
      disabled={disabled}
      // AURA's spinner, aria-busy and aria-disabled while the request runs,
      // with clicks ignored. Not native `disabled`: the summary dialog closes
      // in the same commit that starts the request, and AURA hands focus
      // back to this button, which a disabled button cannot take (review
      // round 1, US12d-3).
      loading={submitting}
      {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
    >
      {submitting ? t('toast.submitting') : t('button.submit')}
    </Button>
  );
}

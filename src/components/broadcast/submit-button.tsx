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
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

const TIMEOUT_MS = 8000;

export interface SubmitButtonProps {
  readonly disabled: boolean;
  readonly submitting: boolean;
  readonly onClick: () => void;
}

export function SubmitButton({
  disabled,
  submitting,
  onClick,
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

  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled || submitting}
      aria-busy={submitting}
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
